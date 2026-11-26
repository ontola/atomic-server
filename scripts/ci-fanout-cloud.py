#!/usr/bin/env python3
"""Laptop-independent supervisor and stdlib-only deadline reaper for Atomic CI.

Cloud-init must start the independent reaper unit BEFORE bootstrap-run. This
module delegates all CI scheduling to the pinned repository's ci-fanout.py.
Only the retained volume receives allowlisted evidence and validated archives;
provider credentials and SSH private keys stay on the controller boot disk.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

DOCTL_SHA256 = '1033caac941fe6238aa3b3170ac2651117ab259f2eaaa87a252164ed4df405ee'
BUNDLE_FILES = {'atomic-server-binary', 'client.oci.tar', 'checks.oci.tar', 'test-inventory.json'}


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def timestamp(value):
    try:
        result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.utcoffset() is None:
            raise ValueError()
        return result
    except (AttributeError, TypeError, ValueError):
        raise ValueError('expected a timezone-aware ISO timestamp') from None


def slug(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,80}', value)


def validate_config(config):
    config = dict(config)
    if not slug(config.get('batch_key')) or not re.fullmatch(r'[a-f0-9]{40}', config.get('source_commit', '')):
        raise ValueError('invalid batch or source identity')
    began, deadline = timestamp(config['campaign_started_at']), timestamp(config['deadline'])
    if not 0 < (deadline - began).total_seconds() <= 3600:
        raise ValueError('campaign deadline must be within the authorized one hour')
    account, controller, volume, fanout = (config[key] for key in ('account', 'controller', 'volume', 'fanout_config'))
    if not slug(account.get('context')) or not re.fullmatch(r'[a-f0-9-]{36}', account.get('expected_uuid', '')):
        raise ValueError('account identity must be pinned')
    if not slug(controller.get('name')) or not slug(controller.get('size')) or not slug(controller.get('ownership_tag')):
        raise ValueError('invalid controller identity')
    intent = timestamp(controller.get('creation_intent_at'))
    if intent < began.replace(microsecond=0) or intent > deadline:
        raise ValueError('controller creation intent differs from the campaign')
    if type(controller.get('ssh_key_id')) is not int or controller['ssh_key_id'] <= 0 or not slug(controller.get('ssh_key_name')) or not controller.get('ssh_key_fingerprint'):
        raise ValueError('controller SSH key identity must be pinned')
    if volume.get('size_gigabytes') != 10 or not slug(volume.get('name')) or not slug(volume.get('region')) or not isinstance(volume.get('id'), str) or not re.fullmatch(r'[a-f0-9-]{36}', volume['id']):
        raise ValueError('exact retained 10GiB volume identity is required')
    for name, default in (('root', '/root/atomic-ci-control'), ('repo', '/opt/atomic-ci-control/repo')):
        config.setdefault(name, default)
        if not Path(config[name]).is_absolute() or '..' in Path(config[name]).parts:
            raise ValueError(name + ' must be absolute')
    config.setdefault('credentials', str(Path(config['root']) / 'doctl.json'))
    mount = Path(volume['mount_path'])
    if (not mount.is_absolute() or '..' in mount.parts or '..' in Path(config['credentials']).parts
            or not Path(config['credentials']).is_relative_to(Path(config['root']))):
        raise ValueError('invalid private/retained filesystem layout')
    if Path(config['root']).is_relative_to(mount) or Path(config['credentials']).is_relative_to(mount) or Path(config['repo']).is_relative_to(mount):
        raise ValueError('credentials, runtime and source must stay on the boot disk')
    expected = dict(account, nodes=3)
    if fanout.get('accounts') != [expected] or fanout.get('batch_key') != config['batch_key'] or fanout.get('source_commit') != config['source_commit']:
        raise ValueError('fanout account, fleet or source differs from the authorized campaign')
    if fanout.get('region') != volume['region']:
        raise ValueError('controller volume and worker region must match')
    if timestamp(fanout.get('absolute_deadline')) != deadline or not 0 < fanout.get('max_hours', 0) <= 1:
        raise ValueError('fanout cannot extend the original deadline')
    if (fanout.get('worktree') != config['repo'] or fanout.get('runtime_dir') != str(Path(config['root']) / 'runtime')
            or fanout.get('doctl_config') != config['credentials']
            or fanout.get('artifact_archive_dir') != str(mount / 'browser-bundles') or fanout.get('host_bundle_backup') is not True):
        raise ValueError('fanout private runtime and retained archive paths must match')
    config.setdefault('max_total_usd', 7.50)
    config.setdefault('expected_volume_hourly_rate', .0015)
    config.setdefault('cloud_egress_reserve_usd', .15)
    config.setdefault('cleanup_reserve_seconds', 120)
    if type(config['cleanup_reserve_seconds']) is not int or config['cleanup_reserve_seconds'] < 120 or isinstance(config['cloud_egress_reserve_usd'], bool) or not isinstance(config['cloud_egress_reserve_usd'], (int, float)) or not math.isfinite(config['cloud_egress_reserve_usd']) or not 0 <= config['cloud_egress_reserve_usd'] <= .15:
        raise ValueError('invalid cleanup or egress reserve')
    rates = (controller.get('expected_hourly_rate'), fanout.get('expected_hourly_rate'), config['expected_volume_hourly_rate'], config['max_total_usd'])
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in rates):
        raise ValueError('explicit positive prices and budget are required')
    hourly = rates[0] + 3 * rates[1] + rates[2]
    # Reserve two minutes of cleanup at the full rate, without extending work.
    if hourly * ((deadline - began).total_seconds() + config['cleanup_reserve_seconds']) / 3600 + config['cloud_egress_reserve_usd'] > config['max_total_usd'] or config['max_total_usd'] > 7.50:
        raise ValueError('controller, fleet, volume and cleanup reserve exceed the authorized budget')
    return config


def guard_deadline(config, now=None):
    if (now or utcnow()) >= timestamp(config['deadline']):
        raise TimeoutError('original campaign deadline reached')


def credentials(config):
    path = Path(config['credentials'])
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError('credential file cannot traverse symlinks')
    value = json.loads(path.read_text())
    context = config['account']['context']
    token = value.get('auth-contexts', {}).get(context)
    if value.get('context') != context or not isinstance(token, str) or not token:
        raise ValueError('selected account credentials are missing')
    return token


class CloudAPI:
    def __init__(self, config):
        self.config = config
        self.token = credentials(config)

    def request(self, method, path):
        request = urllib.request.Request('https://api.digitalocean.com/v2/' + path.lstrip('/'),
            method=method, headers={'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                data = response.read()
                return json.loads(data) if data else {}
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise RuntimeError('provider API failed with HTTP ' + str(error.code)) from None

    def identity(self):
        value = self.request('GET', 'account')['account']
        actual = value.get('team', {}).get('uuid') or value.get('uuid')
        if actual != self.config['account']['expected_uuid']:
            raise ValueError('provider account UUID differs')
        return actual

    def listing(self, path, key):
        output = []
        for page in range(1, 21):
            value = self.request('GET', path + '?per_page=200&page=' + str(page))
            output.extend(value[key])
            if not value.get('links', {}).get('pages', {}).get('next'):
                return output
        raise RuntimeError('provider listing exceeded bounded pagination')

    def droplets(self):
        return self.listing('droplets', 'droplets')

    def keys(self):
        return self.listing('account/keys', 'ssh_keys')

    def droplet(self, resource_id):
        value = self.request('GET', 'droplets/' + str(resource_id))
        return value['droplet'] if value else None

    def volume(self, resource_id):
        value = self.request('GET', 'volumes/' + str(resource_id))
        return value['volume'] if value else None

    def delete_droplet(self, resource_id):
        self.identity()
        return self.request('DELETE', 'droplets/' + str(resource_id))

    def delete_key(self, resource_id):
        self.identity()
        return self.request('DELETE', 'account/keys/' + str(resource_id))


def metadata():
    with urllib.request.urlopen('http://169.254.169.254/metadata/v1.json', timeout=5) as response:
        return json.loads(response.read())


def verify_controller(config, api, metadata):
    api.identity()
    resource_id = metadata.get('droplet_id')
    if type(resource_id) is not int or resource_id <= 0:
        raise ValueError('controller metadata lacks its exact Droplet ID')
    own = api.droplet(resource_id)
    expected = config['controller']
    rate = own.get('size', {}).get('price_hourly') if own else None
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not math.isfinite(rate):
        raise ValueError('controller provider price is invalid')
    if (not own or own.get('id') != resource_id or own.get('name') != expected['name']
            or metadata.get('hostname') != expected['name'] or metadata.get('region') != config['volume']['region']
            or own.get('region', {}).get('slug') != config['volume']['region'] or own.get('size_slug') != expected['size']
            or expected['ownership_tag'] not in own.get('tags', [])
            or abs(rate - expected['expected_hourly_rate']) > .000001
            or timestamp(own.get('created_at')) < timestamp(expected['creation_intent_at']).replace(microsecond=0)
            or timestamp(own['created_at']) > utcnow() + dt.timedelta(seconds=2)):
        raise ValueError('controller identity, creation time, region or price differs')
    return own


def verify_volume(config, api, own_id):
    volume = api.volume(config['volume']['id'])
    expected = config['volume']
    if (not volume or any(volume.get(key) != expected[key] for key in ('id', 'name', 'size_gigabytes'))
            or volume.get('region', {}).get('slug') != expected['region']
            or volume.get('droplet_ids') != [own_id]):
        raise ValueError('retained volume identity, region, size or attachment differs')
    own = api.droplet(own_id)
    if not own or own.get('volume_ids') != [expected['id']]:
        raise ValueError('controller does not exclusively attach the retained volume')
    return volume


def command(args, timeout=60, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(Path(args[0]).name + ' failed with exit ' + str(result.returncode))
    return result.stdout.strip() if check else result


def verify_mount(config, device=None, observation=None):
    mount = Path(config['volume']['mount_path'])
    device = device or '/dev/disk/by-id/scsi-0DO_Volume_' + config['volume']['name']
    if mount.is_symlink():
        raise ValueError('retained mount cannot be a symlink')
    if observation is None:
        value = json.loads(command(['findmnt', '--json', '--target', str(mount), '--output', 'TARGET,SOURCE,FSTYPE']))
        observation = value['filesystems'][0]
    if (observation.get('target') != str(mount) or observation.get('fstype') != 'ext4'
            or os.path.realpath(observation.get('source', '')) != os.path.realpath(device)):
        raise ValueError('retained mount does not resolve to the verified ext4 volume')
    return mount


def ensure_volume_mounted(config):
    mount = Path(config['volume']['mount_path'])
    if mount.is_symlink() or any(parent.is_symlink() for parent in mount.parents):
        raise ValueError('retained mount cannot traverse symlinks')
    existing = command(['findmnt', '--json', '--mountpoint', str(mount), '--output', 'TARGET,SOURCE,FSTYPE'], check=False)
    if existing.returncode == 0:
        observed = json.loads(existing.stdout)['filesystems'][0]
        # A foreign existing mount must never be hidden beneath our volume.
        return verify_mount(config, observation=observed)
    if existing.returncode != 1:
        raise RuntimeError('cannot determine whether the retained mount already exists')
    device = '/dev/disk/by-id/scsi-0DO_Volume_' + config['volume']['name']
    if command(['blkid', '-s', 'TYPE', '-o', 'value', device]) != 'ext4':
        raise ValueError('retained volume must already be formatted ext4; never format it here')
    mount.mkdir(parents=True, exist_ok=True)
    command(['mount', device, str(mount)])
    return verify_mount(config)


def write_json(path, value):
    path = Path(path)
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError('evidence path cannot traverse symlinks')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp-' + str(os.getpid()))
    if temporary.is_symlink():
        raise ValueError('temporary evidence file cannot be a symlink')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def read_json(path, default=None):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('state cannot be a symlink')
    return json.loads(path.read_text()) if path.exists() else default


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def validate_cached_bundles(config, force=True):
    root = Path(config['volume']['mount_path']) / 'browser-bundles'
    found = []
    proof_path = Path(config['root']) / 'cache-verification.json'
    proofs = read_json(proof_path, {})
    if root.is_symlink():
        raise ValueError('archive root cannot be a symlink')
    for entry in sorted(root.glob('*')):
        if entry.is_symlink() or not entry.is_dir() or '.partial' in entry.name or '.corrupt-' in entry.name:
            continue
        try:
            paths = [entry / 'build-receipt.json', entry / 'COMPLETED', entry / 'bundle/manifest.json',
                     *(entry / 'bundle' / name for name in BUNDLE_FILES)]
            if any(path.is_symlink() or not path.is_file() for path in paths) or (entry / 'bundle').is_symlink():
                continue
            signature = [[path.stat().st_dev, path.stat().st_ino, path.stat().st_size,
                          path.stat().st_mtime_ns, path.stat().st_ctime_ns] for path in paths]
            prior = proofs.get(str(entry), {})
            if not force and prior.get('signature') == signature:
                found.append(prior['proof'])
                continue
            receipt = read_json(entry / 'build-receipt.json')
            manifest = read_json(entry / 'bundle/manifest.json')
            source = receipt.get('source_commit', '')
            if (receipt.get('version') != 1 or receipt.get('build_exit_code') != 0 or not re.fullmatch(r'[a-f0-9]{40}', source)
                    or (entry / 'COMPLETED').read_text().strip() != sha256(entry / 'build-receipt.json')
                    or manifest.get('version') != 2 or manifest.get('sourceCommit') != source or manifest.get('platform') != 'linux/amd64'
                    or receipt.get('manifest_sha256') != sha256(entry / 'bundle/manifest.json') or set(manifest.get('files', {})) != BUNDLE_FILES
                    or any(sha256(entry / 'bundle' / name) != expected for name, expected in manifest['files'].items())):
                continue
            proof = {'path': str(entry), 'source_commit': source, 'manifest_sha256': receipt['manifest_sha256']}
            found.append(proof)
            proofs[str(entry)] = {'signature': signature, 'proof': proof}
        except (OSError, ValueError, KeyError, TypeError):
            continue
    write_json(proof_path, proofs)
    return found


def evidence_allowed(relative):
    parts = relative.parts
    forbidden = {'doctl.json', 'doctl.yaml', 'operator-key', 'operator-key.pub', 'id_ed25519', 'id_rsa'}
    if any(part in forbidden for part in parts):
        return False
    if len(parts) == 1:
        return parts[0] in {'state.json', 'config.json', 'browser-merged.json', 'source-input-reference.json'} or parts[0].endswith('.log')
    return bool(re.fullmatch(r'node-\d{3}', parts[0])) and (parts[1] == 'results' or
        (len(parts) == 2 and (parts[1].endswith('.log') or parts[1] == 'source-inputs.json')))


def persist_evidence(config, final=False):
    mount = verify_mount(config)
    destination = mount / 'runs' / config['batch_key']
    if any(path.is_symlink() for path in (destination, destination.parent, mount)):
        raise ValueError('retained evidence destination cannot be a symlink')
    destination.mkdir(parents=True, exist_ok=True)
    private = [b'-----BEGIN OPENSSH PRIVATE KEY-----', b'-----BEGIN RSA PRIVATE KEY-----']
    if Path(config['credentials']).exists():
        private.append(credentials(config).encode())
    excluded, copied = [], []
    runtime = Path(config['fanout_config']['runtime_dir'])
    if runtime.is_symlink():
        raise ValueError('runtime evidence root cannot be a symlink')
    copy_path = Path(config['root']) / 'evidence-copy-state.json'
    copy_state = read_json(copy_path, {})
    sources = []
    for directory, dirs, files in os.walk(runtime, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        for name in files:
            source = Path(directory) / name
            relative = source.relative_to(runtime)
            if evidence_allowed(relative) and not source.is_symlink():
                sources.append((source, Path('runtime') / relative))
    for name in ('controller.log', 'supervisor.log', 'reaper.log'):
        path = Path(config['root']) / name
        if path.is_file() and not path.is_symlink():
            sources.append((path, Path(name)))
    def signature(path):
        stat = path.stat()
        return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
    for source, relative in sources:
        target = destination / relative
        if target.is_symlink() or any(parent.is_symlink() for parent in target.parents):
            raise ValueError('evidence destination cannot traverse symlinks')
        target.parent.mkdir(parents=True, exist_ok=True)
        observed = signature(source)
        prior = copy_state.get(str(relative), {})
        if target.exists() and prior.get('source') == observed and prior.get('destination') == signature(target):
            copied.append(str(relative))
            continue
        temporary = target.with_name(target.name + '.tmp')
        if temporary.is_symlink():
            raise ValueError('temporary evidence copy cannot be a symlink')
        try:
            with source.open('rb') as src, temporary.open('wb') as out:
                tail = b''
                for chunk in iter(lambda: src.read(1024 * 1024), b''):
                    block = tail + chunk
                    if any(marker in block for marker in private):
                        raise ValueError('private material excluded from evidence')
                    out.write(chunk)
                    tail = block[-max(map(len, private)):]
            temporary.replace(target)
            copy_state[str(relative)] = {'source': observed, 'destination': signature(target)}
            copied.append(str(relative))
        except ValueError:
            excluded.append(str(relative))
            target.unlink(missing_ok=True)
        finally:
            temporary.unlink(missing_ok=True)
    write_json(copy_path, copy_state)
    for name in ('cloud-status.json', 'cleanup-proof.json'):
        value = read_json(Path(config['root']) / name)
        if value is not None:
            write_json(destination / name, value)
    caches = validate_cached_bundles(config, force=final)
    receipt = {'source_commit': config['source_commit'], 'copied_files': copied, 'excluded_private_files': excluded,
               'validated_caches': caches, 'cache_preserved_for_source': any(item['source_commit'] == config['source_commit'] for item in caches),
               'preserved_at': utcnow().isoformat(), 'retained_volume_id': config['volume']['id']}
    write_json(destination / 'evidence.json', receipt)
    state = read_json(runtime / 'state.json', {})
    cloud = read_json(Path(config['root']) / 'cloud-status.json', {})
    summary = {'source_commit': config['source_commit'], 'ci_status': state.get('status', cloud.get('ci_status')),
               'validation_passed_at': state.get('validation_passed_at'),
               'cache_preserved_for_source': receipt['cache_preserved_for_source'], 'validated_caches': caches,
               'backup_attempts': [{key: node.get(key) for key in ('id', 'bundle_backup_status', 'bundle_backup_error', 'bundle_archive_path')}
                                   for node in state.get('nodes', {}).values() if node.get('bundle_backup_status')],
               'deadline': config['deadline'], 'estimated_worker_compute_usd': sum(node.get('compute_usd', 0) for node in state.get('nodes', {}).values()),
               'controller_hourly_usd': config['controller']['expected_hourly_rate'],
               'retained_volume_hourly_usd_estimate': config['expected_volume_hourly_rate'],
               'retained_volume_monthly_usd_estimate': 1.0, 'updated_at': utcnow().isoformat()}
    write_json(destination / 'cloud-summary.json', summary)
    return receipt


def unit(config, kind):
    return 'atomic-ci-' + kind + '-' + config['batch_key'] + '.service'


def supervisor_failed(config, status):
    if status.get('phase') == 'failed':
        return True
    if status.get('phase') not in ('preparing', 'running'):
        return False
    result = command(['systemctl', 'show', '--property=ActiveState', '--value', unit(config, 'supervisor')], check=False)
    return result.returncode == 0 and result.stdout.strip() in ('failed', 'inactive')


def update_runtime(config, update):
    root = Path(config['fanout_config']['runtime_dir'])
    root.mkdir(parents=True, exist_ok=True)
    with (root / 'state.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = root / 'state.json'
        state = read_json(path, {'config': config['fanout_config'], 'batch_key': config['batch_key'],
                                 'source_commit': config['source_commit'], 'nodes': {}, 'keys': {}})
        update(state)
        write_json(path, state)
        return state


def reap_once(config, api=None, now=None, metadata=None):
    config = validate_config(config)
    api = api or CloudAPI(config)
    now = now or utcnow()
    own = verify_controller(config, api, metadata if metadata is not None else globals()['metadata']())
    verify_volume(config, api, own['id'])
    status = read_json(Path(config['root']) / 'cloud-status.json', {})
    finalizing = now >= timestamp(config['deadline']) or (Path(config['root']) / 'FINALIZE').exists()
    stopping = finalizing or supervisor_failed(config, status)
    report = {'checked_at': now.isoformat(), 'source_commit': config['source_commit'], 'account_uuid': config['account']['expected_uuid'],
              'controller_id': own['id'], 'retained_volume_id': config['volume']['id'], 'cleanup_complete': False,
              'worker_ids_deleted': [], 'key_ids_deleted': [], 'errors': [], 'self_delete_requested': False}
    if not stopping:
        return report
    command(['systemctl', 'stop', '--no-block', unit(config, 'fanout')], check=False)
    initial = read_json(Path(config['fanout_config']['runtime_dir']) / 'state.json')
    if initial is not None and (initial.get('batch_key') != config['batch_key'] or initial.get('source_commit') != config['source_commit']
            or initial.get('config', {}).get('source_commit') != config['source_commit']
            or initial.get('config', {}).get('accounts') != config['fanout_config']['accounts']):
        raise ValueError('runtime ledger campaign/account/source provenance differs')
    state = update_runtime(config, lambda value: value.update(stop_requested=True))
    existing = api.droplets()
    nodes = state.get('nodes', {})
    expected_names = {config['batch_key'] + '-node-' + str(index).zfill(3) for index in range(1, 4)}
    recorded = {node.get('name') for node in nodes.values()}
    for item in existing:
        if item.get('name') in expected_names - recorded:
            report['errors'].append('unrecorded worker identity requires reconciliation')
    for key, node in nodes.items():
        try:
            if node.get('account') != config['account']['context'] or node.get('name') not in expected_names:
                raise ValueError('worker ledger account/name differs')
            resource_id = node.get('droplet_id')
            matches = [item for item in existing if item.get('name') == node['name']]
            if resource_id is None and node.get('creation_attempted_at'):
                if not node.get('creation_absence_verified') or node.get('creation_account_uuid') != config['account']['expected_uuid']:
                    raise ValueError('unknown worker lacks creation ownership')
                if len(matches) > 1:
                    raise ValueError('ambiguous worker create')
                if matches:
                    item = matches[0]
                    if (timestamp(item['created_at']) < timestamp(node['creation_attempted_at']).replace(microsecond=0)
                            or timestamp(item['created_at']) > now + dt.timedelta(seconds=2)):
                        raise ValueError('unknown worker predates creation attempt')
                    resource_id = item['id']
                    update_runtime(config, lambda value: value['nodes'][key].update(droplet_id=resource_id, created_at=item['created_at'], actual_size=item['size']))
                    node = read_json(Path(config['fanout_config']['runtime_dir']) / 'state.json')['nodes'][key]
                elif (now - timestamp(node['creation_attempted_at'])).total_seconds() < 120:
                    raise ValueError('worker create still awaiting provider reconciliation')
            if resource_id is None:
                if matches:
                    raise ValueError('live worker lacks a recorded creation attempt')
                continue
            if any(item['id'] != resource_id for item in matches):
                report['errors'].append(key + ': unexpected same-name worker ID is not owned')
            item = api.droplet(resource_id)
            if item:
                if item.get('id') != resource_id or item.get('name') != node['name'] or item.get('created_at') != node.get('created_at'):
                    raise ValueError('known worker ID/name/created_at differs')
                api.identity()
                api.delete_droplet(resource_id)
                report['worker_ids_deleted'].append(resource_id)
            elif not node.get('deletion_verified') and (now - timestamp(node.get('creation_attempted_at') or node['created_at'])).total_seconds() < 120:
                raise ValueError('known worker absence still awaiting provider reconciliation')
            if any(item['id'] == resource_id for item in api.droplets()):
                raise ValueError('worker deletion absence not verified')
            deleted_at = node.get('deleted_at') or now.isoformat()
            elapsed = max(0, (timestamp(deleted_at) - timestamp(node['created_at'])).total_seconds())
            rate = node.get('actual_size', {}).get('price_hourly', config['fanout_config']['expected_hourly_rate'])
            update_runtime(config, lambda value: value['nodes'][key].update(deleted_at=deleted_at, deletion_verified=True,
                lifetime_seconds=node.get('lifetime_seconds', elapsed), compute_usd=node.get('compute_usd', max(.01, max(60, elapsed) / 3600 * rate))))
        except (ValueError, KeyError, TypeError, RuntimeError) as error:
            report['errors'].append(key + ': ' + str(error))
    keys = dict(state.get('keys', {}))
    if finalizing:
        keys['controller'] = {'id': config['controller']['ssh_key_id'], 'name': config['controller']['ssh_key_name'],
                              'fingerprint': config['controller']['ssh_key_fingerprint']}
    for context, key in keys.items():
        try:
            if context not in (config['account']['context'], 'controller'):
                raise ValueError('SSH key ledger account differs')
            listed = api.keys()
            resource_id = key.get('id')
            if resource_id is None and key.get('creation_attempted'):
                if not key.get('creation_absence_verified') or key.get('creation_account_uuid') != config['account']['expected_uuid']:
                    raise ValueError('unknown SSH key lacks creation ownership')
                matches = [item for item in listed if item.get('name') == key['name'] and item.get('public_key', '').strip() == key.get('public_key')]
                if len(matches) > 1:
                    raise ValueError('ambiguous SSH key import')
                if matches:
                    resource_id, key = matches[0]['id'], matches[0]
                    update_runtime(config, lambda value: value['keys'][context].update(id=resource_id, fingerprint=key['fingerprint']))
                elif (now - timestamp(key['creation_attempted_at'])).total_seconds() < 120:
                    raise ValueError('SSH key import still awaiting provider reconciliation')
            item = next((item for item in listed if item['id'] == resource_id), None)
            if not item and resource_id is not None and context != 'controller' and not key.get('deletion_verified') and (now - timestamp(key.get('creation_attempted_at'))).total_seconds() < 120:
                raise ValueError('known SSH key absence still awaiting provider reconciliation')
            if item:
                if item.get('name') != key.get('name') or item.get('fingerprint') != key.get('fingerprint'):
                    raise ValueError('SSH key ID/name/fingerprint differs')
                api.identity()
                api.delete_key(resource_id)
                report['key_ids_deleted'].append(resource_id)
            if resource_id is not None and any(item['id'] == resource_id for item in api.keys()):
                raise ValueError('SSH key deletion absence not verified')
            if resource_id is not None and context != 'controller':
                update_runtime(config, lambda value: value['keys'][context].update(deletion_verified=True))
        except (ValueError, KeyError, TypeError, RuntimeError) as error:
            report['errors'].append(context + ': ' + str(error))
    if any(item.get('name') in expected_names for item in api.droplets()):
        report['errors'].append('expected-name worker fleet absence is not verified')
    expected_key_names = {key.get('name') for key in keys.values()}
    if any(item.get('name') in expected_key_names for item in api.keys()):
        report['errors'].append('owned SSH key absence is not verified')
    report['cleanup_complete'] = not report['errors']
    report['self_delete_requested'] = finalizing and report['cleanup_complete']
    report['estimated_controller_compute_usd'] = max(.01, max(60, (now - timestamp(own['created_at'])).total_seconds()) / 3600 * config['controller']['expected_hourly_rate'])
    write_json(Path(config['root']) / 'cleanup-proof.json', report)
    ensure_volume_mounted(config)
    persist_evidence(config, final=report['self_delete_requested'])
    if report['self_delete_requested']:
        # DELETE /droplets/<id> detaches the retained volume; never delete it.
        verify_controller(config, api, metadata if metadata is not None else globals()['metadata']())
        api.delete_droplet(own['id'])
    return report


def bootstrap_run(config, api=None, metadata=None):
    config = validate_config(config)
    guard_deadline(config)
    api = api or CloudAPI(config)
    root = Path(config['root'])
    root.mkdir(parents=True, exist_ok=True)
    status_path = root / 'cloud-status.json'
    if read_json(status_path, {}).get('phase') in ('running', 'complete'):
        raise ValueError('campaign already started; never replay completed tests')
    write_json(status_path, {'phase': 'preparing', 'source_commit': config['source_commit']})
    try:
        own = verify_controller(config, api, metadata if metadata is not None else globals()['metadata']())
        verify_volume(config, api, own['id'])
        ensure_volume_mounted(config)
        guard_deadline(config)
        if not shutil.which('git') or not shutil.which('ssh'):
            command(['apt-get', 'update'], timeout=min(120, (timestamp(config['deadline']) - utcnow()).total_seconds()))
            guard_deadline(config)
            command(['apt-get', 'install', '-y', 'git', 'openssh-client'], timeout=min(120, (timestamp(config['deadline']) - utcnow()).total_seconds()))
        guard_deadline(config)
        installed = read_json(root / 'doctl-install.json', {})
        binary = Path('/usr/local/bin/doctl')
        if binary.is_symlink():
            raise ValueError('doctl executable cannot be a symlink')
        if not (installed.get('archive_sha256') == DOCTL_SHA256 and binary.is_file() and not binary.is_symlink() and installed.get('binary_sha256') == sha256(binary)):
            with urllib.request.urlopen('https://github.com/digitalocean/doctl/releases/download/v2.7.0/doctl-2.7.0-linux-amd64.tar.gz', timeout=min(30, (timestamp(config['deadline']) - utcnow()).total_seconds())) as response:
                payload = response.read()
            if hashlib.sha256(payload).hexdigest() != DOCTL_SHA256:
                raise ValueError('pinned doctl download checksum differs')
            archive = root / 'doctl.tar.gz'
            archive.write_bytes(payload)
            with tarfile.open(archive) as source:
                member = source.getmember('doctl')
                if not member.isfile():
                    raise ValueError('doctl archive does not contain a regular binary')
                with source.extractfile(member) as src, Path('/usr/local/bin/doctl').open('wb') as out:
                    shutil.copyfileobj(src, out)
            Path('/usr/local/bin/doctl').chmod(0o755)
            write_json(root / 'doctl-install.json', {'archive_sha256': DOCTL_SHA256, 'binary_sha256': sha256(binary)})
        guard_deadline(config)
        repo = Path(config['repo'])
        repo.mkdir(parents=True, exist_ok=True)
        if not (repo / '.git').exists():
            command(['git', 'init', str(repo)])
            command(['git', '-C', str(repo), 'remote', 'add', 'origin', 'https://github.com/ontola/atomic-server.git'])
        guard_deadline(config)
        command(['git', '-C', str(repo), 'fetch', '--depth=1', 'origin', config['source_commit']],
                timeout=min(300, (timestamp(config['deadline']) - utcnow()).total_seconds()))
        guard_deadline(config)
        command(['git', '-C', str(repo), 'checkout', '--detach', config['source_commit']])
        if command(['git', '-C', str(repo), 'rev-parse', 'HEAD']) != config['source_commit'] or command(['git', '-C', str(repo), 'status', '--porcelain']):
            raise ValueError('source checkout is not the exact clean pin')
        guard_deadline(config)
        path = root / 'fanout-config.json'
        write_json(path, config['fanout_config'])
        command(['systemd-run', '--unit=' + unit(config, 'fanout'), '--property=KillMode=control-group',
                 '--property=TimeoutStopSec=10', '--property=Restart=no',
                 '--property=StandardOutput=append:' + str(root / 'controller.log'),
                 '--property=StandardError=append:' + str(root / 'controller.log'),
                 '--setenv=PATH=/usr/local/bin:/usr/bin:/bin', sys.executable,
                 str(repo / 'scripts/ci-fanout.py'), '--config', str(path), 'run'])
        write_json(status_path, {'phase': 'running', 'source_commit': config['source_commit'], 'started_at': utcnow().isoformat()})
        while True:
            guard_deadline(config)
            receipt = persist_evidence(config)
            state = read_json(Path(config['fanout_config']['runtime_dir']) / 'state.json', {})
            if state.get('finished_at'):
                write_json(status_path, {'phase': 'complete', 'source_commit': config['source_commit'],
                    'ci_status': state.get('status'), 'cache_preserved_for_source': receipt['cache_preserved_for_source'],
                    'finished_at': utcnow().isoformat()})
                persist_evidence(config, final=True)
                return state
            result = command(['systemctl', 'is-active', '--quiet', unit(config, 'fanout')], check=False)
            if result.returncode:
                raise RuntimeError('fanout service exited before verified cleanup')
            time.sleep(10)
    except BaseException as error:
        write_json(status_path, {'phase': 'failed', 'source_commit': config['source_commit'], 'error': type(error).__name__ + ': ' + str(error)})
        raise


def status_snapshot(config):
    state = read_json(Path(config['fanout_config']['runtime_dir']) / 'state.json', {})
    nodes = state.get('nodes', {})
    checks = sorted({name[6:] for node in nodes.values() for name, result in node.get('phase_results', {}).items()
                     if name.startswith('check-') and result.get('status') in ('passed', 'failed')})
    return {'source_commit': state.get('source_commit', config['source_commit']), 'status': state.get('status', 'not-started'),
            'deadline': state.get('deadline', config['deadline']), 'completed_checks': checks,
            'browser_counts': state.get('browser_result_stats'), 'browser_test_count': state.get('full_browser_test_count'),
            'nodes': [{key: node.get(key) for key in ('id', 'phase', 'status', 'deleted_at', 'bundle_backup_status')}
                      for node in nodes.values()]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('command', choices=('bootstrap-run', 'reap', 'status'))
    args = parser.parse_args()
    config = validate_config(read_json(args.config))
    if args.command == 'bootstrap-run':
        bootstrap_run(config)
    elif args.command == 'status':
        print(json.dumps({'supervisor': read_json(Path(config['root']) / 'cloud-status.json', {}),
                          'cleanup': read_json(Path(config['root']) / 'cleanup-proof.json', {}),
                          'fanout': status_snapshot(config)}, indent=2))
    else:
        while True:
            try:
                result = reap_once(config)
                print(json.dumps(result), flush=True)
                if result.get('self_delete_requested'):
                    return
            except Exception as error:
                print(utcnow().isoformat(), 'reaper retry:', type(error).__name__, str(error), flush=True)
            time.sleep(10)


if __name__ == '__main__':
    main()
