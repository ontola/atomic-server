#!/usr/bin/env python3
"""Launch the existing CI controller on DO; retain only its authorized 10 GiB disk.

`plan` is read-only. `launch` is the only provisioning command. Bootstrap and
cleanup run as independent remote services, without an SSH session or laptop.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import tarfile
import uuid

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('cloud_launch_base', Path(__file__).with_name('ci-fanout.py'))
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
ROOT = '/root/atomic-ci-control'
MOUNT = '/mnt/atomic-ci'
CLEANUP_SECONDS = 120
FORBIDDEN = {'browser-bundles','doctl.yaml','doctl.json','doctl-selected.json','operator-key',
             'operator-key.pub','controller-key','controller-key.pub','id_ed25519','id_ed25519.pub',
             'id_rsa','id_rsa.pub','user-data.txt','user-data.yaml','launch-config.json','credentials','secrets'}


def validate_config(config):
    config = BASE.validate_config(dict(config))
    if len(config['accounts']) != 1 or config['accounts'][0]['nodes'] != 3:
        raise ValueError('cloud launch requires one account and exactly three test machines')
    if config['max_hours'] > 1:
        raise ValueError('cloud launch is bounded to one hour including controller bootstrap')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,49}', config['batch_key']):
        raise ValueError('cloud batch_key must be a short lowercase hostname component')
    for field in ('cloud_controller_size', 'cloud_volume_name'):
        if not isinstance(config.get(field), str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', config[field]):
            raise ValueError('invalid ' + field)
    if config.setdefault('cloud_volume_gib', 10) != 10:
        raise ValueError('the authorized persistent volume is exactly 10 GiB')
    for field, default in (('expected_controller_hourly_rate', None), ('expected_volume_hourly_rate', .0015),
                            ('max_total_usd', 7.5), ('cloud_egress_reserve_usd', .15)):
        value = config.setdefault(field, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError('invalid ' + field)
    if not config['expected_controller_hourly_rate'] or not config['expected_volume_hourly_rate'] or not 0 < config['max_total_usd'] <= 7.5:
        raise ValueError('positive prices and a total ceiling at most $7.50 are required')
    if config.get('cloud_volume_id') and not re.fullmatch(r'[0-9a-f-]{36}', config['cloud_volume_id']):
        raise ValueError('cloud_volume_id must be an explicit UUID')
    return config


def checked_source(config):
    repo = Path(config['worktree'])
    def git(*args):
        return BASE.execute(['git', '-C', str(repo), *args])
    if git('rev-parse', 'HEAD').decode().strip() != config['source_commit'] or git('status', '--porcelain=v1', '--untracked-files=no').strip():
        raise ValueError('cloud launch requires the exact clean configured source')
    result = {}
    for name in ('ci-fanout-cloud-launch.py', 'ci-fanout-cloud.py'):
        path = 'scripts/' + name
        try:
            committed = git('show', config['source_commit'] + ':' + path)
        except RuntimeError:
            raise ValueError('cloud scripts must first be committed and integrated into the configured source') from None
        if (repo / path).read_bytes() != committed:
            raise ValueError('cloud script differs from the pinned source: ' + name)
        if Path(__file__).with_name(name).read_bytes() != committed:
            raise ValueError('executing launcher/supervisor differs from the pinned source')
        result[name] = committed
    for name in ('ci-fanout.py','ci-fanout-runner.py'):
        committed = git('show', config['source_commit'] + ':scripts/' + name)
        executing = Path(BASE.__file__).with_name(name)
        if executing.read_bytes() != committed or (repo / 'scripts' / name).read_bytes() != committed:
            raise ValueError('executing CI controller/runner differs from the pinned source')
    return result



def validate_remote_contract(config):
    spec = importlib.util.spec_from_file_location('cloud_launch_contract', Path(__file__).with_name('ci-fanout-cloud.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_config(config)


def selected_credentials(config_path, context):
    import yaml
    document = yaml.safe_load(Path(config_path).read_text())
    token = document.get('auth-contexts', {}).get(context) if isinstance(document, dict) else None
    if not isinstance(token, str) or not token.strip():
        raise ValueError('selected doctl account context has no token')
    return {'context': context, 'auth-contexts': {context: token}}


def cloud_init(supervisor_bytes, config, credentials):
    batch = config['batch_key']
    script = ROOT + '/ci-fanout-cloud.py'
    config_path = ROOT + '/launch-config.json'
    def unit(command, restart):
        return ('[Unit]\nWants=network-online.target\nAfter=network-online.target\n[Service]\nType=simple\n'
                'UMask=0077\nKillMode=control-group\nTimeoutStopSec=10\nRestart=' + restart + '\nRestartSec=10\n'
                'StandardOutput=append:' + ROOT + ('/reaper.log' if command=='reap' else '/supervisor.log') + '\n' +
                'StandardError=append:' + ROOT + ('/reaper.log' if command=='reap' else '/supervisor.log') + '\n' +
                'ExecStart=/usr/bin/python3 ' + script + ' --config ' + config_path + ' ' + command +
                '\n[Install]\nWantedBy=multi-user.target\n')
    files = [(script, supervisor_bytes, '0600'), (config_path, json.dumps(config).encode(), '0600'),
             (ROOT + '/doctl.json', json.dumps(credentials).encode(), '0600'),
             ('/etc/systemd/system/atomic-ci-reaper-' + batch + '.service', unit('reap', 'always').encode(), '0644'),
             ('/etc/systemd/system/atomic-ci-supervisor-' + batch + '.service', unit('bootstrap-run', 'no').encode(), '0644')]
    lines = ['#cloud-config', 'write_files:']
    for path, data, permissions in files:
        lines.extend(['  - path: ' + path, '    owner: root:root', "    permissions: '" + permissions + "'",
                      '    encoding: b64', '    content: ' + base64.b64encode(data).decode()])
    # There is deliberately no packages/apt directive before these services.
    lines.extend(['runcmd:', '  - [systemctl, daemon-reload]',
        '  - [systemctl, enable, --now, atomic-ci-reaper-' + batch + '.service]',
        '  - [systemctl, enable, --now, atomic-ci-supervisor-' + batch + '.service]'])
    data = '\n'.join(lines) + '\n'
    if len(data.encode()) > 65536:
        raise ValueError('cloud-init exceeds the DigitalOcean 64 KiB user-data limit')
    return data


def extract_reports(archive_path, destination):
    """Only regular members below reports/ are accepted; never follow links."""
    destination = Path(destination)
    if destination.is_symlink():
        raise ValueError('report extraction destination is a symlink')
    root = destination.resolve()
    with tarfile.open(archive_path) as archive:
        files = []
        seen = set()
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'reports':
                raise ValueError('unsafe report archive path')
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise ValueError('report archive contains a link or special file')
            if any(part in FORBIDDEN for part in path.parts):
                raise ValueError('report archive contains credentials or a large bundle cache')
            target = root.joinpath(*path.parts)
            for current in (target, *target.parents):
                if current == root.parent:
                    break
                if current.is_symlink():
                    raise ValueError('report extraction target contains a symlink')
            if member.isfile():
                if path in seen:
                    raise ValueError('report archive contains duplicate file paths')
                seen.add(path)
                files.append((member,target))
        # Validate every member before writing any of them.
        for member,target in files:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('wb') as output:
                import shutil
                shutil.copyfileobj(source, output)


class CloudLauncher:
    def __init__(self, config, api=None, run=None, now=None):
        self.config = validate_config(config)
        self.root = Path(self.config['runtime_dir'])
        self.path = self.root / 'launcher.json'
        self.account = self.config['accounts'][0]
        frozen = self.root / 'doctl-selected.json'
        self.api = api or BASE.DigitalOcean(frozen if frozen.is_file() else self.config['doctl_config'])
        self.run = run or BASE.execute
        self.now = now or BASE.utcnow

    def read(self):
        state = json.loads(self.path.read_text())
        if (state['source_commit'] != self.config['source_commit'] or state['account'] != self.account
                or state['batch_key'] != self.config['batch_key']):
            raise ValueError('launcher journal differs from the configured source/account')
        return state

    def update(self, function):
        with (self.root / 'launcher.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = self.read()
            function(state)
            temporary = self.root / ('launcher-' + uuid.uuid4().hex + '.tmp')
            temporary.write_text(json.dumps(state, indent=2) + '\n')
            temporary.chmod(0o600)
            temporary.replace(self.path)
            return state

    def plan(self):
        if self.root.exists():
            raise ValueError('use a fresh local runtime directory; inspect an existing launch with status')
        scripts = checked_source(self.config)
        credentials = selected_credentials(self.config['doctl_config'], self.account['context'])
        worker = BASE.Controller(self.config, api=self.api).plan()
        info = self.api.identity(self.account)
        droplets = self.api.call(self.account, ['compute', 'droplet', 'list'])
        if len(droplets) + 4 > info['droplet_limit']:
            raise ValueError('quota must fit the controller and all three test machines')
        if any(item['name'] == self.config['batch_key'] + '-controller' for item in droplets):
            raise ValueError('controller name already exists; refusing a second fleet')
        sizes = self.api.call(self.account, ['compute', 'size', 'list'])
        for slug, expected, cores in ((self.config['size'], self.config['expected_hourly_rate'], 64),
                                      (self.config['cloud_controller_size'], self.config['expected_controller_hourly_rate'], None)):
            item = next((value for value in sizes if value['slug'] == slug), None)
            if (not item or not item.get('available') or self.config['region'] not in item.get('regions', [])
                    or abs(item['price_hourly'] - expected) > .000001 or cores and item['vcpus'] != cores):
                raise ValueError('requested machine size, region, architecture profile or price is unavailable')
        volumes = self.api.call(self.account, ['compute', 'volume', 'list'])
        if self.config.get('cloud_volume_id'):
            volume = next((item for item in volumes if item['id'] == self.config['cloud_volume_id']), None)
            self.check_volume(volume, reused=True)
        elif any(item['name'] == self.config['cloud_volume_name'] for item in volumes):
            raise ValueError('volume name exists; explicit authorized reuse by ID is required')
        keys = self.api.call(self.account, ['compute', 'ssh-key', 'list'])
        if any(item['name'] == self.config['batch_key'] + '-controller-key' for item in keys):
            raise ValueError('controller SSH key name already exists')
        hourly = 3 * self.config['expected_hourly_rate'] + self.config['expected_controller_hourly_rate'] + self.config['expected_volume_hourly_rate']
        ceiling = hourly * (self.config['max_hours'] + CLEANUP_SECONDS / 3600) + self.config['cloud_egress_reserve_usd']
        if ceiling > self.config['max_total_usd']:
            raise ValueError('controller, test machines, storage, cleanup and egress exceed the authorized budget')
        began = self.now()
        moment = began.isoformat()
        dummy = {'campaign_started_at': moment, 'deadline': (began+dt.timedelta(hours=self.config['max_hours'])).isoformat(),
            'controller': {'name':self.config['batch_key']+'-controller','ownership_tag':'atomic-ci-cloud-'+'0'*32,
                           'intent_at':moment,'creation_intent_at':moment},
            'ssh_key': {'id':9999999999999999999,'name':self.config['batch_key']+'-controller-key','fingerprint':':'.join(['00']*16)},
            'volume': {'id':'00000000-0000-0000-0000-000000000000','name':self.config['cloud_volume_name'],
                       'description':'atomic-ci-cloud:'+self.account['expected_uuid']+':'+'0'*32,'intent_at':moment,'created_at':moment}}
        remote = self.remote_config(dummy)
        validate_remote_contract(remote)
        userdata_bytes = len(cloud_init(scripts['ci-fanout-cloud.py'],remote,credentials).encode())
        if userdata_bytes > 65536-512:
            raise ValueError('cloud-init leaves insufficient room under the 64 KiB user-data limit')
        return {'source_commit': self.config['source_commit'], 'test_nodes': 3,
                'controller_size': self.config['cloud_controller_size'], 'region': self.config['region'],
                'persistent_volume_gib': 10, 'maximum_hours': self.config['max_hours'],
                'cleanup_reserve_seconds': CLEANUP_SECONDS, 'hourly_usd': hourly, 'cloud_init_bytes':userdata_bytes,
                'egress_reserve_usd': self.config['cloud_egress_reserve_usd'], 'maximum_estimated_usd': ceiling,
                'fresh_checks': worker['check_jobs'], 'source_file_sha256': {
                    name: hashlib.sha256(data).hexdigest() for name, data in scripts.items()}}

    def check_volume(self, volume, reused=False):
        region = volume.get('region', {}).get('slug') if volume else None
        if (not volume or volume['name'] != self.config['cloud_volume_name']
                or volume['size_gigabytes'] != 10 or region != self.config['region']
                or volume.get('filesystem_type') != 'ext4' or volume.get('droplet_ids')):
            raise ValueError('persistent volume identity, size, region, filesystem or attachment differs')
        if reused and volume['id'] != self.config['cloud_volume_id']:
            raise ValueError('persistent volume ID differs from explicit authorization')

    def record_volume(self, volume):
        self.check_volume(volume, reused=bool(self.config.get('cloud_volume_id')))
        state = self.read()
        if not self.config.get('cloud_volume_id'):
            if volume.get('description') != state['volume']['description'] or not self.created_after(volume, state['volume']['intent_at']):
                raise ValueError('new volume does not match its recorded creation intent')
        self.update(lambda value: value['volume'].update(id=volume['id'], created_at=volume['created_at'],
                    description=volume.get('description','')))

    @staticmethod
    def created_after(item, intent):
        created = dt.datetime.fromisoformat(item['created_at'].replace('Z', '+00:00'))
        return created >= dt.datetime.fromisoformat(intent).replace(microsecond=0)

    def reconcile_volume(self):
        state = self.read()
        matches = [item for item in self.api.call(self.account, ['compute', 'volume', 'list'])
                   if item['name'] == state['volume']['name'] and item.get('description') == state['volume']['description']]
        if len(matches) > 1:
            raise ValueError('ambiguous volume creation remains unresolved')
        if matches:
            self.record_volume(matches[0])

    def reconcile_key(self):
        state = self.read(); expected = state['ssh_key']
        matches = [item for item in self.api.call(self.account, ['compute', 'ssh-key', 'list'])
                   if item['name'] == expected['name'] and item['fingerprint'] == expected['fingerprint']
                   and item.get('public_key', '').split()[:2] == expected['public_key'].split()[:2]]
        if len(matches) > 1:
            raise ValueError('ambiguous controller SSH key creation remains unresolved')
        if matches:
            self.update(lambda value: value['ssh_key'].update(id=matches[0]['id']))

    def record_controller(self, item):
        state = self.read(); expected = state['controller']
        if (item['name'] != expected['name'] or item.get('region', {}).get('slug') != self.config['region']
                or item.get('size_slug') != self.config['cloud_controller_size']
                or expected['ownership_tag'] not in item.get('tags', [])
                or not self.created_after(item, expected['intent_at'])
                or abs(item['size']['price_hourly'] - self.config['expected_controller_hourly_rate']) > .000001):
            raise ValueError('controller does not match its exact creation and price intent')
        addresses = [value['ip_address'] for value in item.get('networks', {}).get('v4', []) if value['type'] == 'public']
        self.update(lambda value: value['controller'].update(id=item['id'], created_at=item['created_at'],
                    ip=addresses[0] if addresses else None, actual_hourly_rate=item['size']['price_hourly']))

    def reconcile_controller(self):
        state = self.read(); expected = state['controller']
        matches = [item for item in self.api.call(self.account, ['compute', 'droplet', 'list'])
                   if item['name'] == expected['name'] and expected['ownership_tag'] in item.get('tags', [])]
        if len(matches) > 1:
            raise ValueError('ambiguous controller creation remains unresolved')
        if matches:
            self.record_controller(matches[0])
            return True
        return False

    def launch(self):
        plan = self.plan()
        scripts = checked_source(self.config)
        credentials = selected_credentials(self.config['doctl_config'], self.account['context'])
        self.root.mkdir(mode=0o700, parents=True, exist_ok=False)
        frozen = self.root / 'doctl-selected.json'
        frozen.write_text(json.dumps(credentials)); frozen.chmod(0o600)
        self.api.config_path = str(frozen)
        nonce = uuid.uuid4().hex
        state = {'version': 1, 'batch_key': self.config['batch_key'], 'source_commit': self.config['source_commit'],
                 'account': self.account, 'plan': plan, 'status': 'initializing',
                 'volume': {'name': self.config['cloud_volume_name'],
                     'description': 'atomic-ci-cloud:' + self.account['expected_uuid'] + ':' + nonce},
                 'ssh_key': {'name': self.config['batch_key'] + '-controller-key'},
                 'controller': {'name': self.config['batch_key'] + '-controller', 'ownership_tag': 'atomic-ci-cloud-' + nonce}}
        self.path.write_text(json.dumps(state, indent=2) + '\n'); self.path.chmod(0o600)
        try:
            if self.config.get('cloud_volume_id'):
                values = self.api.call(self.account, ['compute', 'volume', 'get', self.config['cloud_volume_id']])
                self.record_volume(values[0] if isinstance(values, list) else values)
            else:
                self.update(lambda value: value['volume'].update(intent_at=self.now().isoformat()))
                try:
                    values = self.api.call(self.account, ['compute', 'volume', 'create', self.config['cloud_volume_name'],
                        '--size', '10GiB', '--region', self.config['region'], '--fs-type', 'ext4',
                        '--desc', self.read()['volume']['description'], '--http-retry-max', '0'])
                    self.record_volume(values[0] if isinstance(values, list) else values)
                except BaseException:
                    self.reconcile_volume()
                    raise
            self.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.root / 'controller-key')])
            (self.root / 'controller-key').chmod(0o600)
            (self.root / 'controller-key.pub').chmod(0o600)
            public = (self.root / 'controller-key.pub').read_text().strip()
            raw = hashlib.md5(base64.b64decode(public.split()[1])).hexdigest()
            fingerprint = ':'.join(raw[index:index+2] for index in range(0, 32, 2))
            self.update(lambda value: value['ssh_key'].update(public_key=public, fingerprint=fingerprint, intent_at=self.now().isoformat()))
            try:
                values = self.api.call(self.account, ['compute', 'ssh-key', 'import', self.read()['ssh_key']['name'],
                    '--public-key-file', str(self.root / 'controller-key.pub'), '--http-retry-max', '0'])
                key = values[0] if isinstance(values, list) else values
                if key['name'] != self.read()['ssh_key']['name'] or key['fingerprint'] != fingerprint or key.get('public_key', '').split()[:2] != public.split()[:2]:
                    raise ValueError('imported SSH key differs from its ownership intent')
                self.update(lambda value: value['ssh_key'].update(id=key['id']))
            except BaseException:
                self.reconcile_key()
                raise
            began = self.now()
            deadline = began + dt.timedelta(hours=self.config['max_hours'])
            if self.config.get('absolute_deadline'):
                deadline = min(deadline, dt.datetime.fromisoformat(self.config['absolute_deadline'].replace('Z', '+00:00')))
            if began >= deadline:
                raise TimeoutError('authorized deadline expired before controller provisioning')
            self.update(lambda value: value.update(campaign_started_at=began.isoformat(), deadline=deadline.isoformat(), status='controller_create_pending'))
            self.update(lambda value: value['controller'].update(intent_at=began.isoformat(),creation_intent_at=began.replace(microsecond=0).isoformat()))
            remote = self.remote_config()
            userdata = self.root / 'user-data.yaml'
            userdata.write_text(cloud_init(scripts['ci-fanout-cloud.py'], remote, credentials)); userdata.chmod(0o600)
            try:
                values = self.api.call(self.account, ['compute', 'droplet', 'create', self.read()['controller']['name'],
                    '--region', self.config['region'], '--size', self.config['cloud_controller_size'],
                    '--image', 'ubuntu-24-04-x64', '--ssh-keys', str(self.read()['ssh_key']['id']),
                    '--volumes', self.read()['volume']['id'], '--tag-name', self.read()['controller']['ownership_tag'],
                    '--user-data-file', str(userdata), '--http-retry-max', '0'])
                self.record_controller(values[0] if isinstance(values, list) else values)
            except BaseException:
                self.reconcile_controller()
                raise
            finally:
                userdata.unlink(missing_ok=True)
            self.update(lambda value: value.update(status='launched'))
            return self.summary()
        except BaseException:
            self.update(lambda value: value.update(status='launch_interrupted_inspect_journal'))
            if not self.read()['controller'].get('intent_at'):
                try:
                    self.cleanup_unlaunched_key()
                except Exception as error:
                    self.update(lambda value: value.update(key_cleanup_error=str(error)))
            raise

    def cleanup_unlaunched_key(self):
        key = self.read()['ssh_key']
        if not key.get('id'):
            return
        items = self.api.call(self.account, ['compute','ssh-key','list'])
        actual = next((item for item in items if item['id']==key['id']),None)
        if actual and (actual['name']!=key['name'] or actual['fingerprint']!=key['fingerprint']
                       or actual.get('public_key','').split()[:2]!=key['public_key'].split()[:2]):
            raise ValueError('refusing to delete a foreign SSH key after failed launch')
        if actual:
            self.api.call(self.account,['compute','ssh-key','delete',str(key['id']),'--force','--http-retry-max','0'])
        import time
        for attempt in range(12):
            if not any(item['id']==key['id'] for item in self.api.call(self.account,['compute','ssh-key','list'])):
                self.update(lambda value:value['ssh_key'].update(deletion_verified=True))
                return
            if attempt<11:
                time.sleep(1)
        raise RuntimeError('unlaunched controller key absence is not verified')

    def remote_config(self, state=None):
        state = state or self.read()
        fanout = dict(self.config, worktree='/opt/atomic-ci-control/repo', runtime_dir=ROOT + '/runtime',
                      doctl_config=ROOT + '/doctl.json', absolute_deadline=state['deadline'], host_bundle_backup=True,
                      oci_probe_dir='/opt/atomic-ci-control/repo/scripts/ci-fanout/oci-smoke',
                      artifact_archive_dir=MOUNT + '/browser-bundles')
        return {'account': {key:self.account[key] for key in ('context','expected_uuid')}, 'batch_key': self.config['batch_key'], 'source_commit': self.config['source_commit'],
                'deadline': state['deadline'], 'campaign_started_at': state['campaign_started_at'],
                'root': ROOT, 'repo': '/opt/atomic-ci-control/repo', 'credentials': ROOT + '/doctl.json',
                'controller': dict(state['controller'], size=self.config['cloud_controller_size'],
                    expected_hourly_rate=self.config['expected_controller_hourly_rate'],
                    ssh_key_id=state['ssh_key']['id'], ssh_key_name=state['ssh_key']['name'],
                    ssh_key_fingerprint=state['ssh_key']['fingerprint']),
                'volume': dict(state['volume'], size_gigabytes=10, region=self.config['region'], mount_path=MOUNT),
                'fanout_config': fanout, 'max_total_usd': self.config['max_total_usd'],
                'expected_volume_hourly_rate': self.config['expected_volume_hourly_rate'],
                'cloud_egress_reserve_usd': self.config['cloud_egress_reserve_usd'], 'cleanup_reserve_seconds': CLEANUP_SECONDS}

    def summary(self):
        state = self.read()
        return {key: state.get(key) for key in ('batch_key', 'source_commit', 'status', 'campaign_started_at', 'deadline')} | {
            'controller_id': state['controller'].get('id'), 'controller_ip': state['controller'].get('ip'),
            'retained_volume_id': state['volume'].get('id'), 'journal': str(self.path)}

    def ssh(self, command, timeout=30):
        node = self.read()['controller']
        if not node.get('ip'):
            raise RuntimeError('controller has no discovered public IP yet')
        return self.run(['ssh', '-i', str(self.root / 'controller-key'), '-o', 'BatchMode=yes',
            '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ConnectTimeout=8',
            '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-o', 'StrictHostKeyChecking=accept-new',
            '-o', 'UserKnownHostsFile=' + str(self.root / 'controller.known-hosts'),
            'root@' + node['ip'], command], timeout=timeout, text=True)

    def status(self):
        self.api.identity(self.account)
        present = self.reconcile_controller()
        summary = self.summary()
        summary['controller_present'] = present
        if present and summary.get('controller_ip'):
            try:
                summary['remote'] = json.loads(self.ssh('/usr/bin/python3 ' + ROOT + '/ci-fanout-cloud.py --config ' + ROOT + '/launch-config.json status'))
            except (RuntimeError, subprocess.TimeoutExpired, ValueError):
                summary['remote'] = {'status': 'not reachable; bootstrap may still be in progress'}
        return summary

    def collect(self):
        self.api.identity(self.account)
        if not self.reconcile_controller():
            raise RuntimeError('controller is absent; reports remain on the retained volume for a future authorized mount')
        batch = self.config['batch_key']
        # The supervisor only preserves an allowlist in this one run directory.
        source = MOUNT + '/runs/' + batch
        command = "python3 - <<'PYREMOTE'\nimport pathlib,tarfile\np=pathlib.Path(" + repr(source) + ")\nif not p.is_dir() or p.is_symlink(): raise ValueError('run reports are not available')\nwith tarfile.open('/tmp/atomic-ci-reports.tgz','w:gz') as a:\n for f in p.rglob('*'):\n  if f.is_file() and not f.is_symlink() and not any(q in " + repr(sorted(FORBIDDEN)) + " for q in f.relative_to(p).parts):\n   a.add(f,arcname='reports/'+str(f.relative_to(p)),recursive=False)\nPYREMOTE"
        self.ssh(command, timeout=120)
        node = self.read()['controller']
        archive = self.root / 'reports.tgz'
        options = ['-i', str(self.root / 'controller-key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                   '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'UserKnownHostsFile=' + str(self.root / 'controller.known-hosts')]
        self.run(['scp', *options, 'root@' + node['ip'] + ':/tmp/atomic-ci-reports.tgz', str(archive)], timeout=180)
        extract_reports(archive, self.root)
        self.update(lambda state: state.update(reports_collected_at=self.now().isoformat(),
                    reports_sha256=BASE.file_sha256(archive)))
        return {'reports': str(self.root / 'reports'), 'archive_sha256': self.read()['reports_sha256']}

    def finalize(self):
        if not self.read().get('reports_collected_at'):
            raise ValueError('collect the retained reports before requesting early finalization')
        self.api.identity(self.account)
        if not self.reconcile_controller():
            return {'status':'controller already absent; retained reports and volume remain','retained_volume_id':self.read()['volume'].get('id')}
        self.ssh('install -m 600 /dev/null ' + ROOT + '/FINALIZE')
        self.update(lambda state: state.update(finalize_requested_at=self.now().isoformat()))
        return {**self.summary(), 'status': 'finalization requested; deletion still requires independent verification'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('command', choices=('plan', 'launch', 'status', 'collect', 'finalize'))
    args = parser.parse_args()
    launcher = CloudLauncher(json.loads(args.config.read_text()))
    print(json.dumps(getattr(launcher, args.command)(), indent=2))


if __name__ == '__main__':
    main()
