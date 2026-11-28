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
import stat
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
    config.setdefault('cloud_worker_mode', 'cold')
    config.setdefault('region', fanout.get('region'))
    config.setdefault('cloud_controller_region', config['region'])
    config.setdefault('expected_cache_volume_hourly_rate', 0)
    mode = config['cloud_worker_mode']
    if any(fanout.get(field) for field in ('source_snapshot_id', 'source_snapshot_name', 'source_snapshot_profile')):
        raise ValueError('remote snapshot configuration must use the explicit canonical map')
    if mode not in ('cold', 'warm') or not slug(config['region']) or fanout.get('region') != config['region'] or config['cloud_controller_region'] != volume['region']:
        raise ValueError('invalid worker mode or controller/worker region contract')
    clone_rate = config['expected_cache_volume_hourly_rate']
    if isinstance(clone_rate, bool) or not isinstance(clone_rate, (int, float)) or not math.isfinite(clone_rate):
        raise ValueError('invalid temporary cache volume price')
    if mode == 'cold':
        if fanout.get('region') != volume['region'] or clone_rate != 0 or fanout.get('source_snapshots'):
            raise ValueError('cold mode cannot request warm volumes or another worker region')
    else:
        profiles = fanout.get('source_snapshots')
        if not isinstance(profiles, dict) or set(profiles) != {account['context']}:
            raise ValueError('warm mode requires exactly the selected account snapshot')
        profile = profiles[account['context']]
        if (not isinstance(profile, dict) or not slug(profile.get('id')) or not isinstance(profile.get('name'), str) or not profile['name']
                or not slug(fanout.get('cache_namespace')) or profile.get('cache_namespace') != fanout['cache_namespace']
                or not isinstance(profile.get('dagger_engine_version'), str) or not re.fullmatch(r'\d+\.\d+\.\d+', profile['dagger_engine_version'])
                or profile.get('architecture') != 'linux/amd64' or profile.get('docker_data_root') != '/mnt/atomic-ci/docker'
                or fanout.get('test_run_key') != config['batch_key'] or clone_rate <= 0
                or fanout.get('expected_volume_hourly_rate') != clone_rate
                or fanout.get('artifact_cache_dir') != '/var/cache/atomic-ci/browser-bundles'):
            raise ValueError('warm snapshot companion, namespace, fresh run or clone price differs')
    reserve = config.get('cloud_cache_min_free_gib')
    if ('cloud_cache_min_free_gib' in config or 'cloud_cache_min_free_gib' in fanout):
        if (type(reserve) is not int or reserve != 4 or fanout.get('cloud_cache_min_free_gib') != reserve
                or mount != Path('/mnt/atomic-ci')):
            raise ValueError('cache maintenance requires the explicit 4 GiB reserve on the verified fixed mount')
    profile = fanout.get('supplemental_profile')
    if profile is not None and (profile != 'pr2621-native-private-v1' or fanout.get('cold_scratch_gib') != 200 or not isinstance(fanout.get('private_input'), dict)):
        raise ValueError('invalid supplemental native/private profile')
    scratch = fanout.get('cold_scratch_gib')
    rate = config.setdefault('expected_scratch_volume_hourly_rate', 0)
    if scratch is not None:
        if (type(scratch) is not int or scratch != 200 or mode != 'cold'
                or isinstance(rate, bool) or not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate <= 0
                or fanout.get('expected_scratch_volume_hourly_rate') != rate
                or not isinstance(fanout.get('authorization'), str) or not fanout['authorization'].strip()):
            raise ValueError('invalid cold scratch storage contract')
    elif rate != 0:
        raise ValueError('scratch price requires cold scratch mode')
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
    hourly = rates[0] + 3 * rates[1] + rates[2] + (3 * rate if scratch is not None else 0) + 3 * clone_rate
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

    def volumes(self):
        return self.listing('volumes', 'volumes')

    def snapshot(self, resource_id):
        value = self.request('GET', 'snapshots/' + str(resource_id))
        return value['snapshot'] if value else None

    def delete_volume(self, resource_id):
        self.identity()
        return self.request('DELETE', 'volumes/' + str(resource_id))

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


def verify_cache_snapshot(config, api):
    if config['cloud_worker_mode'] != 'warm':
        return None
    api.identity()
    expected = config['fanout_config']['source_snapshots'][config['account']['context']]
    actual = api.snapshot(expected['id'])
    if (not actual or str(actual.get('id')) != expected['id'] or actual.get('name') != expected['name']
            or actual.get('resource_type') != 'volume' or config['region'] not in actual.get('regions', [])
            or type(actual.get('min_disk_size')) is not int or not 0 < actual['min_disk_size'] <= 200):
        raise ValueError('worker cache snapshot identity, type, region or size differs')
    return actual


def fanout_driver(config):
    if config.get('fanout_config', {}).get('supplemental_profile') == 'pr2621-native-private-v1':
        return 'ci-fanout-native.py'
    if config.get('fanout_config', {}).get('cold_scratch_gib'):
        return 'ci-fanout-scratch.py'
    return 'ci-fanout-warm.py' if config.get('cloud_worker_mode', 'cold') == 'warm' else 'ci-fanout.py'


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


def maintain_build_cache(config):
    """Explicit opt-in, after source/volume proof and before any worker launch."""
    if 'cloud_cache_min_free_gib' not in config:
        return None
    guard_deadline(config)
    mount = verify_mount(config)
    if mount != Path('/mnt/atomic-ci'):
        raise ValueError('cache maintenance is restricted to the verified fixed mount')
    import importlib.util
    def load(name):
        spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(config['repo']) / 'scripts' / (name+'.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    helper, base = load('ci-cache-prune'), load('ci-fanout')
    receipt = helper.prune_cache(mount / 'browser-bundles', config['source_commit'],
        config['cloud_cache_min_free_gib'] * 1024**3, base.validate_archive, lambda: guard_deadline(config))
    guard_deadline(config)
    write_json(Path(config['root']) / 'cache-maintenance.json', receipt)
    return receipt


def evidence_allowed(relative):
    parts = relative.parts
    forbidden = {'doctl.json', 'doctl.yaml', 'operator-key', 'operator-key.pub', 'id_ed25519', 'id_rsa'}
    if any(part in forbidden for part in parts):
        return False
    if len(parts) == 1:
        return parts[0] in {'state.json', 'config.json', 'browser-merged.json', 'source-input-reference.json', 'warm-volumes.json', 'warm-cleanup.json', 'scratch-volumes.json', 'scratch-cleanup.json'} or parts[0].endswith('.log')
    return bool(re.fullmatch(r'node-\d{3}', parts[0])) and (parts[1] == 'results' or
        (len(parts) == 2 and (parts[1].endswith('.log') or parts[1] in ('source-inputs.json', 'cache-startup.json', 'cache-startup-observation.json', 'scratch-startup.json'))))


class PrivateEvidenceError(ValueError):
    """Only private material is excluded; integrity errors remain fatal."""


class SourceEvidenceChanged(ValueError):
    """A concurrently retrieved source needs another complete verified pass."""


def evidence_signature(path):
    info = path.stat()
    value = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
    if path.suffix.lower() == '.json' or info.st_size <= 64 * 1024:
        value.append(sha256(path))
    return value


def owned_evidence_file(path, device=None):
    if any(parent.is_symlink() for parent in path.parents):
        raise ValueError('evidence file cannot traverse symlinks')
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or device is not None and info.st_dev != device):
        raise ValueError('evidence must be an owned regular file on its verified filesystem')
    return info


def scan_evidence(path, private, output=None, *, retry_source_change=False):
    """Hash and privacy-scan exact stable bytes, including chunk boundaries."""
    owned_evidence_file(path)
    before = evidence_signature(path)
    digest, tail = hashlib.sha256(), b''
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            block = tail + chunk
            if any(marker in block for marker in private):
                raise PrivateEvidenceError('private material excluded from evidence')
            digest.update(chunk)
            if output is not None:
                output.write(chunk)
            tail = block[-max(map(len, private)):]
    owned_evidence_file(path)
    if evidence_signature(path) != before:
        error = SourceEvidenceChanged if retry_source_change else ValueError
        raise error('evidence changed during verified read')
    return digest.hexdigest()


def large_browser_attachment(relative, size):
    parts = relative.parts
    return (size > 64 * 1024 and relative.suffix.lower() in ('.zip', '.png', '.webm')
            and len(parts) > 4 and parts[0] == 'runtime'
            and re.fullmatch(r'node-\d{3}', parts[1]) and parts[2] == 'results'
            and 'browser' in parts[3:-1])


def persist_evidence(config, final=False):
    """One writer owns copy state and aliases, including independent reapers."""
    root = Path(config['root'])
    if root.is_symlink() or any(parent.is_symlink() for parent in root.parents):
        raise ValueError('evidence lock root cannot traverse symlinks')
    root.mkdir(parents=True, exist_ok=True)
    info = root.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise ValueError('evidence lock root is not owned')
    fd = os.open(root / 'evidence-copy.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            raise ValueError('evidence lock must be an owned unshared regular file')
        fcntl.flock(lock, fcntl.LOCK_EX)
        for attempt in range(3):
            try:
                if attempt:
                    guard_evidence_retry_deadline(config)
                    return _persist_evidence_locked(config, final, retrying=True)
                return _persist_evidence_locked(config, final)
            except SourceEvidenceChanged:
                if attempt == 2:
                    raise


def guard_evidence_retry_deadline(config):
    # Additional preservation attempts may use only the already-budgeted cleanup
    # reserve. Never change the work deadline or block an original late reaper pass.
    cutoff = timestamp(config['deadline']) + dt.timedelta(seconds=config['cleanup_reserve_seconds'])
    if utcnow() >= cutoff:
        raise TimeoutError('original evidence cleanup window reached')


def _persist_evidence_locked(config, final=False, retrying=False):
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
    if copy_path.is_symlink():
        raise ValueError('evidence copy state cannot be a symlink')
    copy_state = read_json(copy_path, {})
    sources = []
    for directory, dirs, files in os.walk(runtime, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        for name in files:
            source = Path(directory) / name
            relative = source.relative_to(runtime)
            if evidence_allowed(relative) and not source.is_symlink():
                sources.append((source, Path('runtime') / relative))
    for name in ('controller.log', 'supervisor.log', 'reaper.log', 'cache-maintenance.json'):
        path = Path(config['root']) / name
        if path.is_file() and not path.is_symlink():
            sources.append((path, Path(name)))
    device = mount.stat().st_dev
    attachments = {}
    for source, relative in sources:
        target = destination / relative
        if target.is_symlink() or any(parent.is_symlink() for parent in target.parents):
            raise ValueError('evidence destination cannot traverse symlinks')
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.parent.stat().st_dev != device:
            raise ValueError('evidence destination is outside its verified filesystem')
        owned_evidence_file(source)
        observed = evidence_signature(source)
        prior = copy_state.get(str(relative), {})
        current = None
        if target.exists():
            owned_evidence_file(target, device)
            current = evidence_signature(target)
        unchanged = prior.get('source') == observed and prior.get('destination') == current and current is not None
        attachment = large_browser_attachment(relative, observed[2])
        temporary = target.with_name(target.name + '.tmp')
        if temporary.exists() or temporary.is_symlink():
            raise ValueError('temporary evidence copy already exists; reconciliation required')
        try:
            content = prior.get('content_sha256') if unchanged and attachment else None
            if attachment and not content:
                content = scan_evidence(source, private, retry_source_change=True)
            candidate = attachments.get((observed[2], content)) if attachment else None
            if candidate:
                other, proof = candidate
                owned_evidence_file(other, device)
                if evidence_signature(other) != proof:
                    if scan_evidence(other, private) != content:
                        candidate = None
            if candidate and current and current[:2] == evidence_signature(candidate[0])[:2]:
                unchanged = True
            elif candidate:
                other = candidate[0]
                proof = evidence_signature(other)
                os.link(other, temporary, follow_symlinks=False)
                owned_evidence_file(temporary, device)
                linked = evidence_signature(temporary)
                # link(2) changes ctime only; bytes and inode must stay exact.
                if linked[:4] != proof[:4] or evidence_signature(source) != observed:
                    raise ValueError('attachment changed while creating verified alias')
                temporary.replace(target)
                unchanged = True
            if not unchanged:
                # An earlier interrupted copy can be reused only after full
                # content/privacy proof; this also enables existing-report repair.
                if attachment and current and scan_evidence(target, private) == content:
                    unchanged = True
                else:
                    with temporary.open('xb') as out:
                        copied_hash = scan_evidence(source, private, out, retry_source_change=True)
                    if content is not None and copied_hash != content:
                        raise ValueError('attachment changed between verified reads')
                    temporary.replace(target)
            owned_evidence_file(target, device)
            record = {'source': observed, 'destination': evidence_signature(target)}
            if attachment:
                record['content_sha256'] = content
                attachments[(observed[2], content)] = (target, record['destination'])
            copy_state[str(relative)] = record
            copied.append(str(relative))
        except PrivateEvidenceError:
            excluded.append(str(relative))
            target.unlink(missing_ok=True)
            copy_state.pop(str(relative), None)
        finally:
            temporary.unlink(missing_ok=True)
    # Creating or removing an alias changes every sibling inode's ctime. Save
    # all resulting signatures together, so the next unchanged pass is a no-op.
    alias_proofs = {}
    for relative, record in list(copy_state.items()):
        relative_path = Path(relative)
        if (relative_path.is_absolute() or '..' in relative_path.parts
                or (relative_path.parts[:1] == ('runtime',)
                    and not evidence_allowed(Path(*relative_path.parts[1:])))
                or relative_path.parts[:1] != ('runtime',) and relative not in
                    ('controller.log', 'supervisor.log', 'reaper.log', 'cache-maintenance.json')):
            raise ValueError('cached evidence identity is outside the retained report')
        path = destination / relative_path
        if path.exists():
            owned_evidence_file(path, device)
            current = evidence_signature(path)
            previous = record['destination']
            if current != previous:
                content = record.get('content_sha256')
                if current[:4] != previous[:4] or not isinstance(content, str) or not re.fullmatch(r'[a-f0-9]{64}',content):
                    raise ValueError('retained evidence changed outside alias bookkeeping')
                # Prove bytes before accepting changed ctime. Link count updates
                # must never bless an unrelated in-place mutation of a shared blob.
                identity = tuple(current)
                if identity not in alias_proofs:
                    alias_proofs[identity] = scan_evidence(path, private)
                if alias_proofs[identity] != content:
                    raise ValueError('shared attachment changed during preservation')
            record['destination'] = current
        else:
            copy_state.pop(relative)
    caches = validate_cached_bundles(config, force=final)
    if retrying:
        guard_evidence_retry_deadline(config)
    write_json(copy_path, copy_state)
    for name in ('cloud-status.json', 'cleanup-proof.json'):
        value = read_json(Path(config['root']) / name)
        if value is not None:
            write_json(destination / name, value)
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
               'retained_volume_monthly_usd_estimate': 1.0, 'worker_mode': config.get('cloud_worker_mode', 'cold'),
               'temporary_cache_volume_hourly_usd_estimate': config.get('expected_cache_volume_hourly_rate', 0), 'updated_at': utcnow().isoformat()}
    if 'worker_budget' in state.get('plan', {}):
        summary['worker_budget'] = state['plan']['worker_budget']
    if config['fanout_config'].get('check_only'):
        summary.update(validation_scope='selected-check', selected_check=config['fanout_config']['check_only'],
                       selected_check_receipt=state.get('selected_check_receipt'),
                       validation_completed_at=state.get('validation_completed_at'))
    if config['fanout_config'].get('cold_scratch_gib'):
        summary.update(storage_mode='cold-scratch', scratch_storage_hourly_usd_estimate=config['expected_scratch_volume_hourly_rate'],
                       scratch_cleanup=read_json(runtime / 'scratch-cleanup.json'))
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


def reap_cache_volumes(config, api, state, now):
    """Independent stdlib fallback: never detach/delete by name alone."""
    root = Path(config['fanout_config']['runtime_dir'])
    path = root / 'warm-volumes.json'
    result = {'errors': [], 'cache_volume_ids_deleted': [], 'all_deleted': False, 'estimated_storage_usd': 0}
    expected = {config['batch_key'] + '-node-' + str(index).zfill(3) + '-cache' for index in range(1, 4)}
    account = config['account']
    selected = config['fanout_config']['source_snapshots'][account['context']]
    with (root / 'warm-volumes.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            result['errors'].append('cache-volume creation/cleanup ledger is still locked')
            return result
        ledger = read_json(path, {})
        listed = api.volumes()
        for volume in listed:
            if volume.get('name') in expected and volume['name'] not in ledger:
                result['errors'].append('unrecorded expected-name cache volume is not owned')
        for name, entry in ledger.items():
            try:
                node = state['nodes'][entry['node_id']]
                source = entry.get('source_snapshot', {})
                if (name not in expected or name != node['name'] + '-cache' or entry.get('name') != name
                        or node.get('account') != account['context'] or entry.get('account') != account['context']
                        or entry.get('expected_uuid') != account['expected_uuid'] or entry.get('absence_verified') is not True
                        or source.get('id') != selected['id'] or source.get('name') != selected['name']
                        or source.get('resource_type') != 'volume' or config['region'] not in source.get('regions', [])
                        or not isinstance(entry.get('description'), str)
                        or not re.fullmatch(r'Atomic CI cache ' + re.escape(config['batch_key']) + r' [a-f0-9]{32}', entry['description'])
                        or entry.get('creation_identity_error') or (entry.get('id') is not None and entry['id'] in (config['volume']['id'], source.get('resource_id')))):
                    raise ValueError('cache-volume ledger ownership/snapshot differs')
                attempted = timestamp(entry['attempted_at'])
                resource_id = entry.get('id')
                matches = [volume for volume in listed if volume.get('name') == name]
                if resource_id and any(volume['id'] != resource_id for volume in matches):
                    result['errors'].append(name + ': unexpected same-name cache-volume ID is not owned')
                if not resource_id and len(matches) > 1:
                    raise ValueError('cache-volume creation identity is ambiguous')
                volume = api.volume(resource_id) if resource_id else (matches[0] if matches else None)
                if volume:
                    if (volume.get('id') == config['volume']['id'] or volume.get('name') != name
                            or volume.get('region', {}).get('slug') != config['region'] or volume.get('size_gigabytes') != 200
                            or volume.get('description') != entry['description'] or (resource_id and volume['id'] != resource_id)
                            or timestamp(volume['created_at']) < attempted.replace(microsecond=0)
                            or timestamp(volume['created_at']) > now + dt.timedelta(seconds=2)
                            or volume.get('snapshot_id') not in (None, '', selected['id'])
                            or (entry.get('created_at') and entry['created_at'] != volume['created_at'])):
                        raise ValueError('live cache volume differs from exact owned create intent')
                    entry.update(id=volume['id'], created_at=volume['created_at'])
                    write_json(path, ledger)
                    resource_id = volume['id']
                    if volume.get('droplet_ids'):
                        raise ValueError('cache volume remains attached; delete its owned worker first')
                    if node.get('droplet_id') and api.droplet(node['droplet_id']):
                        raise ValueError('cache-volume worker absence is not verified')
                    requested = entry.get('delete_attempted_at')
                    if not requested or (now - timestamp(requested)).total_seconds() >= 30:
                        entry['delete_attempted_at'] = now.isoformat()
                        write_json(path, ledger)
                        try:
                            api.identity()
                            api.delete_volume(resource_id)
                            result['cache_volume_ids_deleted'].append(resource_id)
                        except (RuntimeError, OSError) as error:
                            entry['delete_response_error'] = str(error)
                    if api.volume(resource_id) is not None or any(volume['id'] == resource_id for volume in api.volumes()):
                        raise ValueError('cache-volume deletion absence is not verified')
                elif not entry.get('delete_attempted_at') and (now - attempted).total_seconds() < 120:
                    raise ValueError('cache-volume creation/absence still awaiting provider reconciliation')
                entry.update(deletion_verified=True, deleted_at=entry.get('deleted_at') or now.isoformat())
                if entry.get('created_at'):
                    seconds = max(60, (timestamp(entry['deleted_at']) - timestamp(entry['created_at'])).total_seconds())
                    entry.setdefault('estimated_storage_usd', seconds / 3600 * config['expected_cache_volume_hourly_rate'])
            except (ValueError, KeyError, TypeError, RuntimeError, OSError) as error:
                result['errors'].append(name + ': ' + str(error))
        known_ids = {entry.get('id') for entry in ledger.values() if entry.get('id')}
        if any(volume.get('name') in expected or volume.get('id') in known_ids for volume in api.volumes()):
            result['errors'].append('temporary cache-volume fleet absence is not verified')
        write_json(path, ledger)
        result['all_deleted'] = not result['errors']
        result['estimated_storage_usd'] = sum(entry.get('estimated_storage_usd', 0) for entry in ledger.values())
        write_json(root / 'warm-cleanup.json', dict(result, at=now.isoformat()))
    return result


def reap_scratch_volumes(config, api, state, now):
    """Stdlib-only cleanup for blank cold disks; never adopts warm/retained disks."""
    runtime = Path(config['fanout_config']['runtime_dir'])
    runtime.mkdir(parents=True, exist_ok=True)
    result = {'errors': [], 'scratch_volume_ids_deleted': [], 'all_deleted': False, 'estimated_storage_usd': 0}
    expected = {config['batch_key'] + '-node-' + str(i).zfill(3) + '-scratch' for i in range(1, 4)}
    path = runtime / 'scratch-volumes.json'
    with (runtime / 'scratch-volumes.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            result['errors'].append('scratch volume ledger is still locked')
            return result
        ledger = read_json(path, {})
        listed = api.volumes()
        for volume in listed:
            if volume.get('name') in expected and volume['name'] not in ledger:
                result['errors'].append('unrecorded expected-name scratch disk is not owned')
        for name, entry in ledger.items():
            try:
                node = state['nodes'][entry['node_id']]
                account = config['account']
                if (name not in expected or name != node['name'] + '-scratch' or entry.get('name') != name
                        or entry.get('storage_kind') != 'cold-scratch' or entry.get('batch_key') != config['batch_key']
                        or entry.get('source_commit') != config['source_commit'] or entry.get('absence_verified') is not True
                        or node.get('account') != account['context'] or entry.get('account') != account['context']
                        or entry.get('expected_uuid') != account['expected_uuid'] or entry.get('creation_identity_error')
                        or not re.fullmatch(r'[a-f0-9]{32}', str(entry.get('nonce', '')))
                        or entry.get('description') != 'Atomic CI scratch ' + config['batch_key'] + ' ' + entry['nonce']
                        or not re.fullmatch(r'[a-f0-9-]{36}', str(entry.get('filesystem_uuid', '')))
                        or (entry.get('id') and (not re.fullmatch(r'[a-f0-9-]{36}', str(entry['id'])) or entry['id'] == config['volume']['id']))):
                    raise ValueError('scratch ledger ownership differs')
                attempted = timestamp(entry['attempted_at'])
                ident = entry.get('id')
                matches = [v for v in listed if v.get('name') == name]
                if len(matches) > 1 or (ident and any(v['id'] != ident for v in matches)):
                    raise ValueError('ambiguous scratch volume identity')
                volume = api.volume(ident) if ident else (matches[0] if matches else None)
                if volume:
                    if (not re.fullmatch(r'[a-f0-9-]{36}', str(volume.get('id', '')))
                            or volume.get('id') == config['volume']['id'] or volume.get('name') != name
                            or volume.get('description') != entry['description'] or volume.get('size_gigabytes') != 200
                            or volume.get('region', {}).get('slug') != config['region']
                            or volume.get('snapshot_id') not in (None, '')
                            or (ident and volume['id'] != ident)
                            or timestamp(volume['created_at']) < attempted - dt.timedelta(seconds=2)
                            or timestamp(volume['created_at']) > now + dt.timedelta(seconds=2)
                            or (entry.get('created_at') and entry['created_at'] != volume['created_at'])):
                        raise ValueError('live scratch volume differs from exact create intent')
                    entry.update(id=volume['id'], created_at=volume['created_at'])
                    write_json(path, ledger)
                    ident = volume['id']
                    if volume.get('droplet_ids') or (node.get('droplet_id') and api.droplet(node['droplet_id'])):
                        raise ValueError('scratch worker/attachment is still present')
                    previous = entry.get('delete_attempted_at')
                    if not previous or (now - timestamp(previous)).total_seconds() >= 30:
                        entry['delete_attempted_at'] = now.isoformat()
                        write_json(path, ledger)
                        try:
                            api.identity()
                            api.delete_volume(ident)
                            result['scratch_volume_ids_deleted'].append(ident)
                        except (RuntimeError, OSError) as error:
                            entry['delete_response_error'] = str(error)
                    if api.volume(ident) is not None or any(v['id'] == ident for v in api.volumes()):
                        raise ValueError('scratch deletion absence not verified')
                elif not entry.get('delete_attempted_at') and (now - attempted).total_seconds() < 120:
                    raise ValueError('scratch creation/absence is still reconciling')
                entry.update(deletion_verified=True, deleted_at=entry.get('deleted_at') or now.isoformat())
                if entry.get('created_at'):
                    seconds = max(60, (timestamp(entry['deleted_at']) - timestamp(entry['created_at'])).total_seconds())
                    entry.setdefault('estimated_storage_usd', seconds / 3600 * config['expected_scratch_volume_hourly_rate'])
            except (KeyError, ValueError, TypeError, RuntimeError, OSError) as error:
                result['errors'].append(name + ': ' + str(error))
        ids = {entry.get('id') for entry in ledger.values() if entry.get('id')}
        if any(v.get('name') in expected or v.get('id') in ids for v in api.volumes()):
            result['errors'].append('scratch fleet absence is not verified')
        result['all_deleted'] = not result['errors']
        result['estimated_storage_usd'] = sum(entry.get('estimated_storage_usd', 0) for entry in ledger.values())
        write_json(path, ledger)
        write_json(runtime / 'scratch-cleanup.json', dict(result, at=now.isoformat()))
    return result


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
    if config['fanout_config'].get('cold_scratch_gib'):
        scratch_result = reap_scratch_volumes(config, api, read_json(Path(config['fanout_config']['runtime_dir']) / 'state.json', {}), now)
        report.update(scratch_volume_ids_deleted=scratch_result['scratch_volume_ids_deleted'],
                      scratch_volumes_all_deleted=scratch_result['all_deleted'], estimated_scratch_storage_usd=scratch_result['estimated_storage_usd'])
        report['errors'].extend(scratch_result['errors'])
    if config['cloud_worker_mode'] == 'warm':
        clones = reap_cache_volumes(config, api, read_json(Path(config['fanout_config']['runtime_dir']) / 'state.json'), now)
        report.update(cache_volume_ids_deleted=clones['cache_volume_ids_deleted'], cache_volumes_all_deleted=clones['all_deleted'],
                      estimated_cache_storage_usd=clones['estimated_storage_usd'])
        report['errors'].extend(clones['errors'])
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
    if config['cloud_worker_mode'] == 'warm':
        ledger = read_json(Path(config['fanout_config']['runtime_dir']) / 'warm-volumes.json', {})
        clone_ids = {entry.get('id') for entry in ledger.values() if entry.get('id')}
        clone_names = {name + '-cache' for name in expected_names}
        if any(volume.get('name') in clone_names or volume.get('id') in clone_ids for volume in api.volumes()):
            report['cache_volumes_all_deleted'] = False
            report['errors'].append('final temporary cache-volume absence is not verified')
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
        verify_cache_snapshot(config, api)
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
        if config['cloud_worker_mode'] == 'warm':
            profile = config['fanout_config']['source_snapshots'][config['account']['context']]
            if read_json(repo / 'dagger.json')['engineVersion'].lstrip('v') != profile['dagger_engine_version']:
                raise ValueError('snapshot engine version differs from the pinned source')
        guard_deadline(config)
        maintain_build_cache(config)
        if config['fanout_config'].get('supplemental_profile'):
            import importlib.util
            spec = importlib.util.spec_from_file_location('private_input', repo / 'scripts/ci-fanout-private-input.py')
            helper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helper)
            helper.wait_controller_input(config, lambda: guard_deadline(config))
        path = root / 'fanout-config.json'
        write_json(path, config['fanout_config'])
        command(['systemd-run', '--unit=' + unit(config, 'fanout'), '--property=KillMode=control-group',
                 '--property=TimeoutStopSec=10', '--property=Restart=no',
                 '--property=StandardOutput=append:' + str(root / 'controller.log'),
                 '--property=StandardError=append:' + str(root / 'controller.log'),
                 '--setenv=PATH=/usr/local/bin:/usr/bin:/bin', sys.executable,
                 str(repo / 'scripts' / fanout_driver(config)), '--config', str(path), 'run'])
        write_json(status_path, {'phase': 'running', 'source_commit': config['source_commit'], 'started_at': utcnow().isoformat()})
        while True:
            guard_deadline(config)
            receipt = persist_evidence(config)
            state = read_json(Path(config['fanout_config']['runtime_dir']) / 'state.json', {})
            scratch_done = (not config['fanout_config'].get('cold_scratch_gib') or
                            read_json(Path(config['fanout_config']['runtime_dir']) / 'scratch-cleanup.json', {}).get('all_deleted') is True)
            if state.get('finished_at') and scratch_done:
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
    scope = ({'validation_scope': 'selected-check', 'selected_check': config['fanout_config']['check_only']}
             if config['fanout_config'].get('check_only') else {})
    if 'worker_budget' in state.get('plan', {}):
        scope['worker_budget'] = state['plan']['worker_budget']
    return {**scope, 'source_commit': state.get('source_commit', config['source_commit']), 'status': state.get('status', 'not-started'),
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
