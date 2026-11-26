#!/usr/bin/env python3
"""Run the ordinary fan-out controller with an existing DO cache snapshot.

This adds owned writable cache volumes, not another CI scheduler. Source/build
validation, fresh tests, final retries, VM billing and VM/key cleanup remain in
ci-fanout.py. A snapshot is only a cache, never evidence that tests passed.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True

VOLUME_GIB = 200
UNKNOWN_CREATE_GRACE_SECONDS = 120
DELETE_RECONCILE_SECONDS = 30


def load_controller():
    spec = importlib.util.spec_from_file_location('atomic_fanout', Path(__file__).with_name('ci-fanout.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path, value):
    temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamps must include a timezone')
    return parsed


def validate_config(config, module):
    # No paid-run defaults: the operator records the current authorized budget.
    for key in ('max_hours', 'expected_hourly_rate', 'expected_volume_hourly_rate',
                'max_total_usd', 'authorization', 'region', 'size', 'doctl_config'):
        if key not in config:
            raise ValueError('warm configuration must explicitly set ' + key)
    config = module.validate_config(dict(config))
    if not re.fullmatch(r'[a-z](?:[a-z0-9-]{0,40}[a-z0-9])?', config['batch_key']):
        raise ValueError('warm batch_key must be a short lowercase DO volume-name prefix')
    if not isinstance(config['authorization'], str) or not config['authorization'].strip():
        raise ValueError('authorization must record the current user instruction')
    for key in ('expected_hourly_rate', 'expected_volume_hourly_rate', 'max_total_usd'):
        value = config[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError('invalid ' + key)
    nodes = sum(account['nodes'] for account in config['accounts'])
    maximum = nodes * (config['expected_hourly_rate'] + config['expected_volume_hourly_rate']) * max(1 / 60, config['max_hours'])
    if maximum > config['max_total_usd'] + 1e-9:
        raise ValueError('configured maximum runtime exceeds max_total_usd')
    if config.get('test_run_key') != config['batch_key']:
        raise ValueError('warm runs require a unique test_run_key equal to batch_key')
    if config['artifact_cache_dir'] != '/var/cache/atomic-ci/browser-bundles':
        raise ValueError('warm artifact_cache_dir must use the volume-backed browser-bundles path')
    if config.get('absolute_deadline'):
        timestamp(config['absolute_deadline'])
    snapshots = config.get('source_snapshots')
    if snapshots is None and len(config['accounts']) == 1:
        companion = config.get('source_snapshot_profile', {})
        if not isinstance(companion, dict):
            raise ValueError('source_snapshot_profile must be an explicit companion object')
        snapshots = {config['accounts'][0]['context']: {**companion,
            'id': config.get('source_snapshot_id'), 'name': config.get('source_snapshot_name')}}
    contexts = {account['context'] for account in config['accounts']}
    if not isinstance(snapshots, dict) or set(snapshots) != contexts:
        raise ValueError('source_snapshots must identify a snapshot for every configured account')
    for context, snapshot in snapshots.items():
        if (not isinstance(snapshot, dict)
                or not isinstance(snapshot.get('id'), str)
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', snapshot['id'])
                or not isinstance(snapshot.get('name'), str) or not snapshot['name'].strip()
                or any(ord(char) < 32 for char in snapshot['name'])):
            raise ValueError('invalid source snapshot for ' + context)
    config['source_snapshots'] = snapshots
    validate_cache_profile(config)
    return config


def validate_cache_profile(config, dagger_version=None):
    namespace = config.get('cache_namespace')
    if not isinstance(namespace, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,80}', namespace):
        raise ValueError('warm mode requires the stable snapshot cache namespace')
    for profile in config['source_snapshots'].values():
        version = profile.get('dagger_engine_version', '')
        if (profile.get('cache_namespace') != namespace or not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version)
                or (dagger_version is not None and version != dagger_version)
                or profile.get('architecture') != 'linux/amd64' or profile.get('docker_data_root') != '/mnt/atomic-ci/docker'):
            raise ValueError('snapshot cache namespace, pinned engine, architecture or Docker root differs')


def validate_startup_cache(config, node, entry, observation):
    """Prove restored nonempty engine state, never a job cache hit."""
    validate_cache_profile(config)
    profile = config['source_snapshots'][node['account']]
    source = entry.get('source_snapshot', {})
    device = '/dev/disk/by-id/scsi-0DO_Volume_' + entry['name']
    version = profile['dagger_engine_version']
    image_version = re.compile(r'^registry\.dagger\.io/engine:v?' + re.escape(version) + r'(?:@sha256:[a-f0-9]+)?$')
    account = next(account for account in config['accounts'] if account['context'] == node['account'])
    failures = []
    def expect(field, actual, expected):
        if actual != expected:
            failures.append(field + ' expected=' + repr(expected)[:180] + ' observed=' + repr(actual)[:400])
    if not isinstance(observation, dict):
        raise ValueError('worker cache startup observation must be an object')
    for field, expected in (('node_id', node['id']), ('account', node['account']),
                            ('expected_uuid', account['expected_uuid']),
                            ('name', node['name'] + '-cache')):
        expect('ledger.' + field, entry.get(field), expected)
    if entry.get('absence_verified') is not True:
        failures.append('ledger.absence_verified expected=True observed=' + repr(entry.get('absence_verified'))[:100])
    expect('ledger.id_present', bool(entry.get('id')), True)
    expect('snapshot.id', source.get('id'), profile['id'])
    expect('snapshot.name', source.get('name'), profile['name'])
    for field, expected in (('volume_name', entry['name']), ('device', device), ('mount_target', '/mnt/atomic-ci'),
                            ('filesystem_type', 'ext4'), ('docker_root_dir', profile['docker_data_root']),
                            ('engine_version', version), ('cache_namespace', config['cache_namespace'])):
        expect(field, observation.get(field), expected)
    expect('filesystem_uuid_present', bool(observation.get('filesystem_uuid')), True)
    expect('mount_source_realpath', observation.get('mount_source_realpath', observation.get('mount_source')),
           observation.get('device_realpath', device))
    count = observation.get('restored_docker_entries')
    if type(count) is not int or count <= 0:
        failures.append('restored_docker_entries expected=positive integer observed=' + repr(count)[:100])
    if observation.get('restored_dagger_cache_nonempty') is not True:
        failures.append('restored_dagger_cache_nonempty expected=True observed=' + repr(observation.get('restored_dagger_cache_nonempty'))[:100])
    images = observation.get('engine_images', [])
    if not isinstance(images, list) or not any(image_version.search(image) for image in images if isinstance(image, str)):
        failures.append('engine_images expected=registry.dagger.io/engine:v' + version + ' observed=' + repr(images)[:400])
    if failures:
        raise ValueError('worker cache startup does not prove the intended nonempty restored engine: ' + '; '.join(failures))
    return dict(observation, restoration_verified=True, cache_hits_proven=False, node_id=node['id'], account=node['account'],
                volume_id=entry['id'], snapshot_id=profile['id'], dagger_engine_version=version,
                cache_namespace_source='snapshot companion and current job configuration')


def verify_snapshot(api, account, config):
    api.identity(account)
    expected = config['source_snapshots'][account['context']]
    response = api.call(account, ['compute', 'snapshot', 'get', expected['id']])
    values = response if isinstance(response, list) else [response]
    if len(values) != 1 or not isinstance(values[0], dict):
        raise ValueError('snapshot lookup did not return exactly one snapshot')
    snapshot = values[0]
    minimum = snapshot.get('min_disk_size')
    regions = snapshot.get('regions')
    if (str(snapshot.get('id')) != expected['id'] or snapshot.get('name') != expected['name']
            or snapshot.get('resource_type') != 'volume'
            or not isinstance(regions, list) or config['region'] not in regions
            or type(minimum) is not int or not 0 < minimum <= VOLUME_GIB):
        raise ValueError('source snapshot identity, type, region or minimum size differs')
    return snapshot


@contextlib.contextmanager
def volume_lock(root):
    with (root / 'warm-volumes.lock').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def owned_volume(volume, entry, account, config):
    try:
        return (entry.get('absence_verified') is True
                and entry.get('account') == account['context']
                and entry.get('expected_uuid') == account['expected_uuid']
                and volume['name'] == entry['name']
                and volume['region']['slug'] == config['region']
                and volume['size_gigabytes'] == VOLUME_GIB
                and volume.get('description') == entry['description']
                and (not entry.get('id') or entry['id'] == volume['id'])
                and timestamp(volume['created_at']) >= timestamp(entry['attempted_at']) - dt.timedelta(seconds=2))
    except (KeyError, TypeError, ValueError):
        return False


def cleanup_volumes(config, module, api=None):
    root = Path(config['runtime_dir'])
    path = root / 'warm-volumes.json'
    if not path.exists():
        return True
    api = api or module.DigitalOcean(config['doctl_config'])
    with volume_lock(root):
        ledger = json.loads(path.read_text())
        state = json.loads((root / 'state.json').read_text())
        accounts = {account['context']: account for account in config['accounts']}
        errors = []
        for name, entry in ledger.items():
            if entry.get('deletion_verified'):
                continue
            try:
                account = accounts[entry['account']]
                node = state['nodes'][entry['node_id']]
                if (name != node['name'] + '-cache' or entry['name'] != name
                        or node['account'] != account['context']
                        or entry.get('expected_uuid') != account['expected_uuid']
                        or not entry.get('absence_verified')):
                    raise ValueError('volume ledger does not identify an owned planned node')
                api.identity(account)
                matches = [volume for volume in api.call(account, ['compute', 'volume', 'list'])
                           if volume['name'] == name]
                if len(matches) > 1:
                    raise ValueError('ambiguous volume identity')
                if matches:
                    volume = matches[0]
                    if not owned_volume(volume, entry, account, config):
                        raise ValueError('volume identity differs from the creation ledger')
                    if volume.get('droplet_ids'):
                        raise ValueError('volume is still attached; remove the owned VM first')
                    entry.update(id=volume['id'], created_at=volume['created_at'])
                    requested = entry.get('delete_attempted_at')
                    if not requested or (module.utcnow() - timestamp(requested)).total_seconds() >= DELETE_RECONCILE_SECONDS:
                        entry['delete_attempted_at'] = module.stamp()
                        write_json(path, ledger)
                        try:
                            api.call(account, ['compute', 'volume', 'delete', volume['id'], '--force', '--http-retry-max', '0'])
                        except Exception as error:
                            entry['delete_response_error'] = str(error)
                    remaining = api.call(account, ['compute', 'volume', 'list'])
                    if any(volume['id'] == item['id'] for item in remaining):
                        raise ValueError('volume deletion is not yet verified')
                elif not entry.get('id'):
                    if (module.utcnow() - timestamp(entry['attempted_at'])).total_seconds() < UNKNOWN_CREATE_GRACE_SECONDS:
                        raise ValueError('reconciling unknown volume creation for at least 120 seconds')
                if entry.get('creation_identity_error'):
                    raise ValueError('provider creation identity was inconsistent; manual reconciliation required')
                entry.update(deletion_verified=True, deleted_at=module.stamp())
                if entry.get('created_at'):
                    seconds = max(60, (module.utcnow() - timestamp(entry['created_at'])).total_seconds())
                    entry['estimated_storage_usd'] = seconds / 3600 * config['expected_volume_hourly_rate']
            except Exception as error:
                errors.append(name + ': ' + str(error))
        write_json(path, ledger)
        write_json(root / 'warm-cleanup.json', {
            'at': module.stamp(), 'errors': errors, 'all_deleted': not errors,
            'estimated_storage_usd': sum(entry.get('estimated_storage_usd', 0) for entry in ledger.values()),
            'storage_rate_source': 'operator-configured expected_volume_hourly_rate; not a provider invoice',
        })
        return not errors


def controller_class(module, api_factory=None):
    factory = api_factory or module.DigitalOcean

    class SnapshotAPI:
        def __init__(self, config):
            self.config = config
            self.root = Path(config['runtime_dir'])
            self.backend = factory(config['doctl_config'])

        @property
        def config_path(self):
            return self.backend.config_path

        @config_path.setter
        def config_path(self, value):
            self.backend.config_path = value

        def identity(self, account):
            return self.backend.identity(account)

        def check_budget(self):
            state = json.loads((self.root / 'state.json').read_text())
            if state.get('stop_requested') or module.utcnow() >= timestamp(state['deadline']):
                raise TimeoutError('warm run stopped or reached its original deadline')
            return state

        def paid_create(self, account, args):
            # Identity verification is a network request too. Check the budget
            # after it, immediately before issuing the actual create request.
            self.backend.identity(account)
            state = self.check_budget()
            if args[:3] == ['compute', 'volume', 'create']:
                path = self.root / 'warm-volumes.json'
                ledger = json.loads(path.read_text())
                ledger[args[3]]['attempted_at'] = module.stamp()
                write_json(path, ledger)
            elif args[:3] == ['compute', 'droplet', 'create']:
                matches = [node for node in state['nodes'].values()
                           if node['name'] == args[3] and node['account'] == account['context']]
                if len(matches) != 1:
                    raise ValueError('VM attempt does not identify one owned planned node')
                node_id = matches[0]['id']
                def refresh(value):
                    node = value['nodes'][node_id]
                    if (not node.get('creation_absence_verified')
                            or node.get('creation_account_uuid') != account['expected_uuid']):
                        raise ValueError('VM attempt lacks the base controller ownership proof')
                    node['creation_attempted_at'] = module.stamp()
                # Controller.create already holds the resource lock. Use its
                # atomic state writer without changing the absence/UUID proof.
                module.Controller(self.config, api=self).update(refresh)
            self.check_budget()
            return self.backend.raw(account, args)

        def call(self, account, args):
            if args[:3] == ['compute', 'droplet', 'create']:
                if '--volumes' in args:
                    raise ValueError('warm VM creation must not attach an unrecorded volume')
                with volume_lock(self.root):
                    state = self.check_budget()
                    nodes = [node for node in state['nodes'].values()
                             if node['name'] == args[3] and node['account'] == account['context']]
                    if len(nodes) != 1:
                        raise ValueError('VM is not a unique owned planned node')
                    node = nodes[0]
                    snapshot = verify_snapshot(self.backend, account, self.config)
                    name = node['name'] + '-cache'
                    path = self.root / 'warm-volumes.json'
                    ledger = json.loads(path.read_text()) if path.exists() else {}
                    if name in ledger:
                        raise ValueError('volume creation already attempted; reconcile instead of retrying')
                    existing = self.backend.call(account, ['compute', 'volume', 'list'])
                    if any(volume['name'] == name for volume in existing):
                        raise ValueError('refusing to adopt a pre-existing cache volume')
                    self.check_budget()
                    entry = {'name': name, 'node_id': node['id'], 'account': account['context'],
                             'expected_uuid': account['expected_uuid'], 'absence_verified': True,
                             'attempted_at': module.stamp(), 'source_snapshot': snapshot,
                             'description': 'Atomic CI cache ' + self.config['batch_key'] + ' ' + uuid.uuid4().hex}
                    ledger[name] = entry
                    write_json(path, ledger)
                    response = self.paid_create(account, ['compute', 'volume', 'create', name,
                        '--snapshot', snapshot['id'], '--size', str(VOLUME_GIB) + 'GiB',
                        '--desc', entry['description'], '--http-retry-max', '0'])
                    volumes = response if isinstance(response, list) else [response]
                    if len(volumes) != 1 or not isinstance(volumes[0], dict):
                        raise RuntimeError('unknown volume creation outcome; reconcile the ledger')
                    volume = volumes[0]
                    if not owned_volume(volume, entry, account, self.config):
                        entry['creation_identity_error'] = True
                        entry['unverified_response_id'] = volume.get('id')
                        write_json(path, ledger)
                        raise ValueError('created volume identity differs from the owned request')
                    entry.update(id=volume['id'], created_at=volume['created_at'])
                    write_json(path, ledger)
                args = [*args, '--volumes', volume['id']]
                return self.paid_create(account, args)
            return self.backend.call(account, args)

    class WarmController(module.Controller):
        def __init__(self, config):
            config = validate_config(config, module)
            super().__init__(config, api=SnapshotAPI(config))

        def plan(self):
            if self.config.get('absolute_deadline') and module.utcnow() >= timestamp(self.config['absolute_deadline']):
                raise TimeoutError('the authorized campaign deadline has passed')
            plan = super().plan()
            validate_cache_profile(self.config, plan['dagger_version'])
            snapshots = {account['context']: verify_snapshot(self.api, account, self.config)
                         for account in self.config['accounts']}
            storage = plan['nodes'] * self.config['expected_volume_hourly_rate']
            plan.update(source_snapshots=snapshots, cache_volume_gib=VOLUME_GIB,
                        storage_hourly_usd_estimate=storage,
                        maximum_compute_and_storage_usd=(plan['hourly_usd'] + storage) * max(1 / 60, self.config['max_hours']),
                        max_total_usd=self.config['max_total_usd'], authorization=self.config['authorization'],
                        snapshot_policy='Existing snapshots are read only; each VM gets its own writable clone.')
            return plan

        def initialize(self, plan):
            super().initialize(plan)
            began = module.utcnow()
            deadline = began + dt.timedelta(hours=self.config['max_hours'])
            if self.config.get('absolute_deadline'):
                deadline = min(deadline, timestamp(self.config['absolute_deadline']))
            self.update(lambda state: state.update(first_creation_at=began.isoformat(), deadline=deadline.isoformat()))

        def prepare(self, node_id):
            super().prepare(node_id)
            node = self.read()['nodes'][node_id]
            account = self.account(node['account'])
            entry = json.loads((self.root / 'warm-volumes.json').read_text())[node['name'] + '-cache']
            self.api.identity(account)
            volumes = self.api.call(account, ['compute', 'volume', 'list'])
            actual = next((item for item in volumes if item['id'] == entry['id']), None)
            if not actual or not owned_volume(actual, entry, account, self.config) or actual.get('droplet_ids') != [node['droplet_id']]:
                raise ValueError('startup cache volume is not the exact clone attached to this worker')
            profile = self.config['source_snapshots'][node['account']]
            device = '/dev/disk/by-id/scsi-0DO_Volume_' + entry['name']
            collector = (
                'import json,os,pathlib,re,subprocess; '
                'read=lambda args:subprocess.check_output(args,text=True).strip(); '
                'data=json.loads(pathlib.Path("/var/lib/atomic-ci-cache-before-start.json").read_text()); '
                'mount=json.loads(read(["findmnt","--json","--mountpoint","/mnt/atomic-ci","--output","TARGET,SOURCE,FSTYPE"]))["filesystems"][0]; '
                'info=json.loads(read(["docker","info","--format","{{json .}}"])); '
                'images=read(["docker","ps","-a","--format","{{.Image}}"]).splitlines(); '
                'data.update(volume_name=' + repr(entry['name']) + ',device=' + repr(device) + ',device_realpath=os.path.realpath(' + repr(device) + '),'
                'mount_target=mount["target"],mount_source=mount["source"],mount_source_realpath=os.path.realpath(mount["source"]),'
                'filesystem_type=mount["fstype"],filesystem_uuid=read(["blkid","-s","UUID","-o","value",' + repr(device) + ']),'
                'docker_root_dir=info["DockerRootDir"],engine_images=images,engine_version=' + repr(profile['dagger_engine_version']) + ','
                'cache_namespace=' + repr(self.config['cache_namespace']) + '); print(json.dumps(data))')
            observation = json.loads(self.ssh(node_id, 'python3 -c ' + shlex.quote(collector), timeout=60))
            observation_path = self.root / node_id / 'cache-startup-observation.json'
            write_json(observation_path, observation)
            self.node_update(node_id, cache_startup_observation_path=str(observation_path))
            try:
                proof = validate_startup_cache(self.config, node, entry, observation)
            except ValueError as error:
                self.node_update(node_id, cache_startup_error=str(error))
                raise
            write_json(self.root / node_id / 'cache-startup.json', proof)
            self.node_update(node_id, cache_startup_proof=proof)

        def cloud_init(self, version):
            text = super().cloud_init(version)
            marker = '  - [systemctl, enable, --now, docker]'
            if text.count(marker) != 1:
                raise ValueError('review the changed base Docker bootstrap before using warm volumes')
            before_start = ('import json,pathlib; root=pathlib.Path("/mnt/atomic-ci/docker"); '
                'entries=list(root.iterdir()) if root.exists() else []; '
                'dagger=[p for p in (root/"volumes").glob("*dagger*/_data") if p.is_dir() and any(p.iterdir())]; '
                'pathlib.Path("/var/lib/atomic-ci-cache-before-start.json").write_text(json.dumps({'
                '"restored_docker_entries":len(entries),"restored_dagger_cache_nonempty":bool(dagger)}))')
            script = ('set -euo pipefail; systemctl stop docker.service docker.socket; '
                'set -- /dev/disk/by-id/scsi-0DO_Volume_' + self.config['batch_key'] + '-node-*-cache; '
                'test "$#" = 1; test -b "$1"; '
                'test "$(blkid -s TYPE -o value "$1")" = ext4; '
                'mkdir -p /mnt/atomic-ci /etc/docker /etc/systemd/system/docker.service.d; '
                'mount "$1" /mnt/atomic-ci; mountpoint -q /mnt/atomic-ci; '
                'volume_uuid=$(blkid -s UUID -o value "$1"); test -n "$volume_uuid"; '
                'printf "UUID=%s /mnt/atomic-ci ext4 defaults 0 2\\n" "$volume_uuid" >> /etc/fstab; '
                'printf "[Unit]\\nRequiresMountsFor=/mnt/atomic-ci\\n[Service]\\nExecStartPre=/usr/bin/mountpoint -q /mnt/atomic-ci\\n" '
                '> /etc/systemd/system/docker.service.d/atomic-ci-volume.conf; '
                'python3 -c ' + shlex.quote(before_start) + '; '
                'mkdir -p /mnt/atomic-ci/docker /mnt/atomic-ci/browser-bundles /var/cache/atomic-ci; '
                'printf \'%s\\n\' \'{"data-root":"/mnt/atomic-ci/docker"}\' >/etc/docker/daemon.json; '
                'if test -e /var/cache/atomic-ci/browser-bundles; then '
                'test "$(readlink -f /var/cache/atomic-ci/browser-bundles)" = /mnt/atomic-ci/browser-bundles; '
                'else ln -s /mnt/atomic-ci/browser-bundles /var/cache/atomic-ci/browser-bundles; fi; '
                'systemctl daemon-reload; systemctl enable --now docker')
            return text.replace(marker, '  - ' + json.dumps(['bash', '-lc', script]))

    return WarmController


def owner_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def watchdog_step(config, module, alive=owner_alive):
    root = Path(config['runtime_dir'])
    started = json.loads((root / 'warm-started.json').read_text())
    path = root / 'state.json'
    if not path.exists():
        return not alive(started['pid']) and cleanup_volumes(config, module)
    state = json.loads(path.read_text())
    should_cleanup = (not state.get('finished_at') and (not alive(started['pid'])
            or module.utcnow() >= timestamp(state['deadline'])
            or state.get('status') == 'cleanup_failed'))
    volumes_done = False
    try:
        if should_cleanup:
            module.Controller(config).cleanup('independent warm-run cleanup watchdog')
    finally:
        # Key-cleanup errors must not keep detached cache volumes billable.
        if should_cleanup or state.get('finished_at'):
            volumes_done = cleanup_volumes(config, module)
    return bool(json.loads(path.read_text()).get('finished_at')) and volumes_done


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('command', choices=('plan', 'run', 'status', 'cleanup', 'watchdog'))
    args = parser.parse_args()
    module = load_controller()
    config = validate_config(json.loads(args.config.read_text()), module)
    controller = controller_class(module)(config)
    if args.command == 'plan':
        print(json.dumps(controller.plan(), indent=2))
        return
    if args.command == 'status':
        print(json.dumps(controller.read(), indent=2))
        return
    if args.command == 'watchdog':
        while True:
            try:
                if watchdog_step(config, module):
                    return
            except Exception as error:
                print(module.stamp(), 'warm cleanup watchdog:', str(error), flush=True)
            time.sleep(5)
    if args.command == 'cleanup':
        try:
            if controller.path.exists():
                module.Controller(config).cleanup('operator warm-run cleanup')
        finally:
            if not cleanup_volumes(config, module):
                raise RuntimeError('owned cache-volume cleanup is pending; inspect warm-cleanup.json')
        return
    root = Path(config['runtime_dir'])
    if root.exists():
        raise ValueError('warm runtime already exists; status/cleanup do not reset its budget')
    root.mkdir(mode=0o700, parents=True)
    write_json(root / 'config.json', config)
    write_json(root / 'warm-started.json', {'pid': os.getpid(), 'at': module.stamp()})
    with (root / 'warm-watchdog.log').open('ab') as output:
        watchdog = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--config',
            str(root / 'config.json'), 'watchdog'], start_new_session=True, stdout=output, stderr=subprocess.STDOUT)
    try:
        controller.run()
    finally:
        try:
            if controller.path.exists() and not controller.read().get('finished_at'):
                module.Controller(config).cleanup('warm-run finally cleanup')
        finally:
            volumes_done = cleanup_volumes(config, module)
            vm_cleanup_done = (not controller.path.exists() or
                               bool(controller.read().get('finished_at')) and not controller.read().get('cleanup_errors'))
            if volumes_done and vm_cleanup_done:
                watchdog.terminate()
                watchdog.wait(timeout=10)


if __name__ == '__main__':
    main()
