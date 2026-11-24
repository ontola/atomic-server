#!/usr/bin/env python3
"""Build browser artifacts once, run independent CI checks, then fan out over DO.

Configuration and credentials stay outside the checkout. `plan` is read-only;
only `run` creates paid resources. Every operation pins an account context and
UUID, and every owned resource is recorded before another phase is launched.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import contextlib
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import uuid

CHECKS = (
    ('js-lint', ['js-lint']),
    ('rust-fmt', ['rust-fmt']),
    ('js-typecheck', ['js-typecheck']),
    ('rust-clippy', ['rust-clippy']),
    ('rust-test', ['rust-test']),
    ('js-test', ['js-test']),
    ('js-test-integration', ['js-test-integration']),
    ('flutter-test', ['flutter-test']),
    ('docs-publish', ['docs-publish', '--netlify-auth-token', 'env://NETLIFY_TOKEN']),
    ('typedoc-publish', ['typedoc-publish', '--netlify-auth-token', 'env://NETLIFY_TOKEN']),
)
BUNDLE_FILES = ('manifest.json', 'atomic-server-binary', 'client.oci.tar', 'test-inventory.json')
MUTATIONS = {'create', 'delete', 'import'}


class PhaseFailure(RuntimeError):
    """A completed check/test failed; independent scheduled work can continue."""

    def __init__(self, node_id, phase, result):
        super().__init__(node_id + ': ' + phase + ' failed')
        self.node_id, self.phase, self.result = node_id, phase, result


class CIValidationFailure(RuntimeError):
    """All selected work completed, with one or more failed checks/tests."""


def completed_phase_failure(node, result):
    """Never turn cancellation, source errors or missing execution into test failures."""
    if result.get('status') != 'failed':
        return False
    commands = result.get('commands', [])
    if not commands or any(item.get('exit_code') != 0 for item in commands[:-1]):
        return False
    exit_code = commands[-1].get('exit_code')
    if (node.get('phase_kind') == 'check'
            and node.get('phase') in {'check-' + name for name, _ in CHECKS}):
        return (type(exit_code) is int and exit_code > 0
                and result.get('error') == 'RuntimeError: phase command exited ' + str(exit_code))
    browser_exit = result.get('browser_exit_code')
    return (node.get('phase_kind') == 'browser' and exit_code == 0
            and type(browser_exit) is int and browser_exit > 0
            and result.get('error') == 'RuntimeError: browser tests exited ' + str(browser_exit))


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def stamp():
    return utcnow().isoformat()


def safe_slug(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,80}', value)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def execute(args, timeout=120, **kwargs):
    result = subprocess.run(args, capture_output=True, timeout=timeout, **kwargs)
    if result.returncode:
        error = result.stderr.decode(errors='replace') if isinstance(result.stderr, bytes) else result.stderr
        raise RuntimeError('Command failed: ' + str(args[0]) + ': ' + error[-1500:])
    return result.stdout


def file_sha256(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def validate_archive(path, source):
    path = Path(path)
    if path.is_symlink() or any((path / 'bundle' / name).is_symlink() for name in BUNDLE_FILES):
        raise ValueError('archive payload must be materialized regular files')
    receipt = json.loads((path / 'build-receipt.json').read_text())
    if receipt.get('version') != 1:
        raise ValueError('unsupported successful build receipt version')
    if ((path / 'COMPLETED').read_text().strip() != file_sha256(path / 'build-receipt.json')
            or receipt.get('source_commit') != source or receipt.get('build_exit_code') != 0):
        raise ValueError('archive does not prove a successful matching build')
    manifest = json.loads((path / 'bundle/manifest.json').read_text())
    if (manifest.get('sourceCommit') != source or manifest.get('platform') != 'linux/amd64'
            or receipt.get('manifest_sha256') != file_sha256(path / 'bundle/manifest.json')
            or set(manifest.get('files', {})) != set(BUNDLE_FILES) - {'manifest.json'}):
        raise ValueError('archive manifest provenance mismatch')
    for name, expected in manifest['files'].items():
        if file_sha256(path / 'bundle' / name) != expected:
            raise ValueError('archive payload hash mismatch: ' + name)
    return receipt, manifest


def validate_config(config):
    if not safe_slug(config.get('batch_key')):
        raise ValueError('batch_key must be a unique safe identifier')
    if not re.fullmatch(r'[0-9a-f]{40}', config.get('source_commit', '')):
        raise ValueError('source_commit must be a full commit SHA')
    for field in ('worktree', 'runtime_dir'):
        if not Path(config.get(field, '')).is_absolute():
            raise ValueError(field + ' must be an absolute path')
    if Path(config['runtime_dir']).is_relative_to(Path(config['worktree'])):
        raise ValueError('runtime_dir must be outside the repository')
    for field, default, low, high in (('max_hours', 4, .01, 4), ('workers', 1, 1, 64),
                                     ('retries', 1, 0, 2), ('build_jobs', 4, 1, 128),
                                     ('rust_test_threads', 0, 0, 128)):
        value = config.setdefault(field, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
            raise ValueError('invalid ' + field)
        if field != 'max_hours' and not isinstance(value, int):
            raise ValueError(field + ' must be an integer')
    for field in ('test_run_key', 'cache_namespace'):
        value = config.setdefault(field, '')
        if not isinstance(value, str) or value and not safe_slug(value):
            raise ValueError('invalid ' + field)
    config.setdefault('oci_probe_dir', str(Path(__file__).resolve().parent / 'ci-fanout/oci-smoke'))
    config.setdefault('artifact_archive_dir', str(Path(config['runtime_dir']).parent.parent / 'artifacts/browser-bundles'))
    if not Path(config['artifact_archive_dir']).is_absolute():
        raise ValueError('artifact_archive_dir must be an absolute local path')
    config.setdefault('artifact_cache_dir', '/var/cache/atomic-ci/browser-bundles')
    if not Path(config['artifact_cache_dir']).is_absolute():
        raise ValueError('artifact_cache_dir must be an absolute host path')
    config.setdefault('region', 'ams3')
    config.setdefault('size', 's-4vcpu-8gb-240gb-intel')
    config.setdefault('expected_hourly_rate', .09524)
    config.setdefault('doctl_config', str(Path.home() / 'Library/Application Support/doctl/config.yaml'))
    if not Path(config['doctl_config']).is_absolute():
        raise ValueError('doctl_config must be an absolute path')
    if not safe_slug(config['region']) or not safe_slug(config['size']):
        raise ValueError('invalid region or size')
    accounts = config.get('accounts')
    if not isinstance(accounts, list) or not accounts:
        raise ValueError('accounts must be a nonempty array')
    contexts = set()
    for account in accounts:
        context = account.get('context')
        if not safe_slug(context) or context in contexts:
            raise ValueError('account contexts must be unique safe identifiers')
        contexts.add(context)
        if not re.fullmatch(r'[0-9a-f-]{36}', account.get('expected_uuid', '')):
            raise ValueError('each account must pin its expected UUID')
        if type(account.get('nodes')) is not int or not 1 <= account['nodes'] <= 128:
            raise ValueError('each account needs a positive node count')
    total = sum(account['nodes'] for account in accounts)
    if not 2 <= total <= 128:
        raise ValueError('total nodes must be between 2 and 128')
    return config


def report_identities(report):
    """Stable collection identity; retries are results of a test, not new tests."""
    identities = []

    def walk(suites, parents=()):
        for suite in suites:
            path = parents + (suite.get('title', ''),)
            for spec in suite.get('specs', []):
                file = spec.get('file', suite.get('file', ''))
                file = file.replace('\\', '/').split('/tests/', 1)[-1]
                for test in spec.get('tests', []):
                    project = test.get('projectName') or test.get('projectId')
                    if not project:
                        raise ValueError('report lacks test project identity')
                    identities.append((project, file, spec.get('line'), spec.get('column'),
                                       path[1:] + (spec['title'],)))
            walk(suite.get('suites', []), path)
    walk(report.get('suites', []))
    if len(set(identities)) != len(identities):
        raise ValueError('report contains duplicate test identities')
    return identities


def verify_browser_report(report, expected_commit, result, index, count, allow_failure=False):
    failed = allow_failure and completed_phase_failure({'phase_kind': 'browser'}, result)
    if result.get('source_commit') != expected_commit or (result.get('status') != 'passed' and not failed):
        raise ValueError('browser phase did not pass on the pinned source')
    if result.get('browser_exit_code') != 0 and not failed:
        raise ValueError('export command success is not browser success')
    if report.get('errors'):
        raise ValueError('browser report contains global errors')
    shard = report.get('config', {}).get('shard')
    if shard != {'current': index, 'total': count}:
        raise ValueError('browser report shard differs from the scheduled shard')
    specs = []

    def walk(suites):
        for suite in suites:
            specs.extend(suite.get('specs', []))
            walk(suite.get('suites', []))
    walk(report.get('suites', []))
    unexpected = 0
    for spec in specs:
        for test in spec.get('tests', []):
            if test.get('status') == 'unexpected' and failed:
                unexpected += 1
                if not test.get('results') or any(r.get('status') == 'interrupted' for r in test['results']):
                    raise ValueError('browser report contains an incomplete test')
            elif test.get('status') not in ('expected', 'flaky', 'skipped'):
                raise ValueError('browser report contains an unsuccessful test')
    if failed and not unexpected:
        raise ValueError('failed browser exit has no completed unsuccessful test')
    return report_identities(report)


def verify_suite_union(inventory, reports):
    expected = set(report_identities(inventory))
    if not expected:
        raise ValueError('full browser inventory is empty')
    seen = set()
    for identities in reports:
        selected = set(identities)
        if seen.intersection(selected):
            raise ValueError('browser shards overlap')
        seen.update(selected)
    if seen != expected:
        raise ValueError('browser shards do not exactly cover the full inventory')
    return len(expected)


class DigitalOcean:
    def __init__(self, config_path):
        self.config_path = str(config_path)

    def raw(self, account, args):
        output = execute(['doctl', '--config', self.config_path, '--context', account['context'],
                          *args, '--output', 'json'], text=True)
        return json.loads(output) if output.strip() else None

    def identity(self, account):
        value = self.raw(account, ['account', 'get'])
        value = value[0] if isinstance(value, list) else value
        identity = value.get('team', {}).get('uuid') or value.get('uuid')
        if identity != account['expected_uuid']:
            raise RuntimeError('DigitalOcean account UUID differs for ' + account['context'])
        return value

    def call(self, account, args):
        if any(arg in MUTATIONS for arg in args[:3]):
            self.identity(account)
        return self.raw(account, args)


class Controller:
    def __init__(self, config, api=None):
        self.config = validate_config(dict(config))
        self.root = Path(config['runtime_dir'])
        self.path = self.root / 'state.json'
        self.api = api or DigitalOcean(self.root / 'doctl.yaml' if (self.root / 'doctl.yaml').exists()
                                       else self.config['doctl_config'])
        self.runner = Path(__file__).with_name('ci-fanout-runner.py')
        self.local_lock = threading.RLock()
        if self.path.exists() and self.read()['config'] != self.config:
            raise ValueError('configuration differs from the immutable batch state')

    @contextlib.contextmanager
    def lock(self, name):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (self.root / (name + '.lock')).open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield

    def read(self):
        return json.loads(self.path.read_text())

    def update(self, function):
        with self.local_lock, self.lock('state'):
            state = self.read()
            function(state)
            temporary = self.root / ('state-' + str(os.getpid()) + '.tmp')
            temporary.write_text(json.dumps(state, indent=2) + '\n')
            temporary.chmod(0o600)
            temporary.replace(self.path)
            return state

    def node_update(self, node_id, **values):
        return self.update(lambda state: state['nodes'][node_id].update(values))

    def account(self, context):
        return next(account for account in self.config['accounts'] if account['context'] == context)

    def event(self, message):
        print(stamp() + ' ' + message, flush=True)

    def plan(self):
        checkout = Path(self.config['worktree'])
        actual = execute(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
        if actual != self.config['source_commit']:
            raise ValueError('worktree HEAD differs from configured source_commit')
        dirty = execute(['git', 'status', '--porcelain=v1', '--untracked-files=no'],
                        cwd=checkout, text=True)
        if dirty:
            raise ValueError('worktree has tracked changes')
        engine = json.loads(execute(['git', 'show', actual + ':dagger.json'],
                                    cwd=checkout, text=True))['engineVersion'].lstrip('v')
        if not re.fullmatch(r'\d+\.\d+\.\d+', engine):
            raise ValueError('Dagger engine version must be pinned')
        accounts = []
        for account in self.config['accounts']:
            info = self.api.identity(account)
            existing = self.api.call(account, ['compute', 'droplet', 'list'])
            if len(existing) + account['nodes'] > info['droplet_limit']:
                raise RuntimeError('Insufficient Droplet quota for ' + account['context'])
            sizes = self.api.call(account, ['compute', 'size', 'list'])
            size = next((item for item in sizes if item['slug'] == self.config['size']), None)
            if not size or not size.get('available') or self.config['region'] not in size.get('regions', []):
                raise RuntimeError('Requested size/region unavailable for ' + account['context'])
            if abs(size['price_hourly'] - self.config['expected_hourly_rate']) > .000001:
                raise RuntimeError('Hourly price differs from configured budget')
            accounts.append({'context': account['context'], 'nodes': account['nodes'],
                             'existing_droplets': len(existing), 'limit': info['droplet_limit']})
        total = sum(account['nodes'] for account in self.config['accounts'])
        return {'source_commit': actual, 'dagger_version': engine, 'accounts': accounts,
                'nodes': total, 'hourly_usd': total * self.config['expected_hourly_rate'],
                'maximum_hours': self.config['max_hours'], 'check_jobs': [name for name, _ in CHECKS],
                'browser_shards': total, 'initial_nodes': min(total, len(CHECKS) + 1),
                'canary_before_remaining_nodes': True}

    def initialize(self, plan):
        if self.path.exists():
            raise ValueError('State already exists; use status/cleanup, never restart a finished batch')
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.root.chmod(0o700)
        source = Path(self.config['doctl_config'])
        frozen = self.root / 'doctl.yaml'
        shutil.copyfile(source, frozen)
        frozen.chmod(0o600)
        self.api.config_path = str(frozen)
        execute(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.root / 'operator-key')])
        nodes = {}
        index = 0
        for account in self.config['accounts']:
            for _ in range(account['nodes']):
                index += 1
                key = 'node-' + str(index).zfill(3)
                nodes[key] = {'id': key, 'account': account['context'],
                              'name': self.config['batch_key'] + '-' + key,
                              'shard_index': index, 'status': 'planned', 'phase_results': {}}
        state = {'version': 1, 'config': self.config, 'source_commit': self.config['source_commit'],
                 'batch_key': self.config['batch_key'], 'plan': plan, 'nodes': nodes,
                 'keys': {}, 'status': 'initialized', 'created_at': stamp(), 'stop_requested': False}
        self.path.write_text(json.dumps(state, indent=2) + '\n')
        self.path.chmod(0o600)
        (self.root / 'cloud-init.yaml').write_text(self.cloud_init(plan['dagger_version']))

    def cloud_init(self, version):
        return '''#cloud-config
package_update: true
packages: [docker.io, git, curl, python3, openssh-client]
runcmd:
  - [systemctl, enable, --now, docker]
  - [bash, -lc, "curl -fsSL https://dl.dagger.io/dagger/install.sh | BIN_DIR=/usr/local/bin DAGGER_VERSION=''' + version + ''' sh"]
  - [bash, -lc, "fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"]
  - [bash, -lc, "mkdir -p /opt/atomic-ci && touch /var/lib/atomic-ci-ready"]
'''

    def check_deadline(self):
        state = self.read()
        if state.get('stop_requested'):
            raise RuntimeError('batch stop requested')
        if state.get('deadline') and utcnow() >= dt.datetime.fromisoformat(state['deadline']):
            raise TimeoutError('batch elapsed-time limit reached')

    def register_keys(self):
        public = (self.root / 'operator-key.pub').read_text().strip()
        for account in self.config['accounts']:
            name = self.config['batch_key'] + '-operator'
            self.update(lambda state: state['keys'].update({account['context']: {'name': name,
                        'public_key': public, 'creation_attempted': True}}))
            try:
                value = self.api.call(account, ['compute', 'ssh-key', 'import', name,
                                               '--public-key-file', str(self.root / 'operator-key.pub'),
                                               '--http-retry-max', '0'])
            except BaseException:
                self.recover_keys(account)
                raise
            value = value[0] if isinstance(value, list) else value
            self.update(lambda state: state['keys'][account['context']].update(
                id=value['id'], fingerprint=value['fingerprint']))

    def recover_keys(self, account):
        key = self.read()['keys'].get(account['context'])
        if not key:
            return
        matches = [item for item in self.api.call(account, ['compute', 'ssh-key', 'list'])
                   if item['name'] == key['name'] and
                   item.get('public_key', '').strip() == key['public_key']]
        if len(matches) > 1:
            raise RuntimeError('ambiguous duplicate owned SSH keys')
        if matches:
            item = matches[0]
            self.update(lambda state: state['keys'][account['context']].update(
                id=item['id'], fingerprint=item['fingerprint']))

    def create(self, node_id):
        with self.lock('resources'):
            self.check_deadline()
            state = self.read()
            node = state['nodes'][node_id]
            if node.get('droplet_id'):
                raise ValueError('node already has a paid resource')
            if not state.get('deadline'):
                started = utcnow()
                self.update(lambda value: value.update(first_creation_at=started.isoformat(),
                    deadline=(started + dt.timedelta(hours=self.config['max_hours'])).isoformat()))
            account = self.account(node['account'])
            self.node_update(node_id, creation_attempted_at=stamp())
            try:
                value = self.api.call(account, ['compute', 'droplet', 'create', node['name'],
                    '--region', self.config['region'], '--size', self.config['size'],
                    '--image', 'ubuntu-24-04-x64', '--ssh-keys', str(state['keys'][node['account']]['id']),
                    '--user-data-file', str(self.root / 'cloud-init.yaml'), '--http-retry-max', '0'])
            except BaseException:
                self.recover_resources()
                raise
            value = value[0] if isinstance(value, list) else value
            self.record_resource(node_id, value)
            if value['name'] != node['name'] or value['size_slug'] != self.config['size']:
                raise RuntimeError('created machine differs from requested identity')
            if abs(value['size']['price_hourly'] - self.config['expected_hourly_rate']) > .000001:
                raise RuntimeError('created machine price differs from budget')
        self.event(node_id + ': created in ' + node['account'])
        self.prepare(node_id)

    def record_resource(self, node_id, item):
        self.node_update(node_id, droplet_id=item['id'], created_at=item['created_at'],
                         actual_size=item['size'], status='bootstrapping')

    def recover_resources(self):
        state = self.read()
        for account in self.config['accounts']:
            names = {node['name']: key for key, node in state['nodes'].items()
                     if node['account'] == account['context'] and node.get('creation_attempted_at')}
            existing = self.api.call(account, ['compute', 'droplet', 'list'])
            for item in existing:
                if item['name'] not in names:
                    continue
                key = names[item['name']]
                known = self.read()['nodes'][key].get('droplet_id')
                if known is None or known == item['id']:
                    if known is None:
                        self.record_resource(key, item)
                else:
                    # A duplicate API create still belongs to this unique name/account.
                    extra = key + '-duplicate-' + str(item['id'])
                    self.update(lambda value: value['nodes'].update({extra: {
                        **value['nodes'][key], 'id': extra, 'droplet_id': item['id'],
                        'created_at': item['created_at'], 'actual_size': item['size'],
                        'resource_only': True, 'status': 'ambiguous-create'}}))

    def ssh_options(self, node, first=False):
        return ['-i', str(self.root / 'operator-key'), '-o', 'BatchMode=yes',
                '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ConnectTimeout=8',
                '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
                '-o', 'StrictHostKeyChecking=' + ('accept-new' if first else 'yes'),
                '-o', 'UserKnownHostsFile=' + str(self.root / (node['id'] + '.known-hosts'))]

    def ssh(self, node_id, command, timeout=45, first=False, input=None):
        node = self.read()['nodes'][node_id]
        return execute(['ssh', *self.ssh_options(node, first), 'root@' + node['ip'], command],
                       timeout=timeout, input=input, text=True)

    def scp(self, node_id, sources, destination, download=False, timeout=180):
        node = self.read()['nodes'][node_id]
        remote = 'root@' + node['ip'] + ':'
        args = ([remote + str(source) for source in sources] + [str(destination)] if download else
                [str(source) for source in sources] + [remote + str(destination)])
        return execute(['scp', *self.ssh_options(node), *args], timeout=timeout, text=True)

    def prepare(self, node_id):
        began = time.monotonic()
        while time.monotonic() - began < 900:
            self.check_deadline()
            node = self.read()['nodes'][node_id]
            value = self.api.call(self.account(node['account']),
                                  ['compute', 'droplet', 'get', str(node['droplet_id'])])
            value = value[0] if isinstance(value, list) else value
            ips = [item['ip_address'] for item in value.get('networks', {}).get('v4', [])
                   if item['type'] == 'public']
            if value['status'] == 'active' and ips:
                self.node_update(node_id, ip=ips[0])
                try:
                    self.ssh(node_id, 'test -f /var/lib/atomic-ci-ready && docker info >/dev/null',
                             timeout=20, first=True)
                    break
                except (RuntimeError, subprocess.TimeoutExpired):
                    pass
            time.sleep(5)
        else:
            raise RuntimeError('machine bootstrap did not become ready')
        source = self.config['source_commit']
        script = '''set -euo pipefail
mkdir -p /opt/atomic-ci/repo /opt/atomic-ci/results
cd /opt/atomic-ci/repo
git init -b develop
git remote add origin https://github.com/ontola/atomic-server.git
git fetch --filter=blob:none origin ''' + source + '''
git checkout --detach ''' + source + '''
test "$(git rev-parse HEAD)" = ''' + source + '''
test -z "$(git status --porcelain)"
dagger version
'''
        output = self.ssh(node_id, 'bash -s', timeout=300, input=script)
        local = self.root / node_id
        local.mkdir(exist_ok=True)
        (local / 'bootstrap.log').write_text(output)
        info = self.ssh(node_id, "docker info --format '{{json .}}'; dagger version")
        (local / 'machine-info.log').write_text(info)
        self.scp(node_id, [self.runner], '/opt/atomic-ci/runner.py')
        self.node_update(node_id, status='ready')

    def phase(self, node_id, name, kind, args, preflight=False, module=None):
        with self.lock(node_id):
            self.check_deadline()
            state = self.read()
            node = state['nodes'][node_id]
            if node.get('deleted_at') or node['status'] not in ('ready', 'waiting'):
                raise ValueError('node is unavailable for a new phase')
            config = {'batch_key': self.config['batch_key'], 'source_commit': self.config['source_commit'],
                      'node_id': node_id, 'phase': name, 'kind': kind, 'args': args,
                      'preflight': preflight, 'module': module,
                      'artifact_cache_dir': self.config['artifact_cache_dir'],
                      'build_jobs': self.config['build_jobs'],
                      'rust_test_threads': self.config['rust_test_threads'],
                      'test_run_key': self.config['test_run_key'],
                      'cache_namespace': self.config['cache_namespace']}
            path = self.root / node_id / (name + '.json')
            path.write_text(json.dumps(config))
            self.scp(node_id, [path], '/opt/atomic-ci/phase.json')
            remaining = max(1, int((dt.datetime.fromisoformat(state['deadline']) - utcnow()).total_seconds()))
            command = ['systemd-run', '--unit=atomic-ci-' + name,
                       '--property=RuntimeMaxSec=' + str(remaining), '--property=KillMode=control-group',
                       '/usr/bin/python3', '/opt/atomic-ci/runner.py', '/opt/atomic-ci/phase.json']
            self.ssh(node_id, shlex.join(command))
            self.node_update(node_id, status='running', phase=name, phase_kind=kind,
                             launched_at=stamp(), phase_config=config)
        self.event(node_id + ': started ' + name)

    def observe(self, node_id):
        node = self.read()['nodes'][node_id]
        path = '/opt/atomic-ci/results/' + node['phase'] + '/result.json'
        command = ('if test -f ' + shlex.quote(path) + '; then cat ' + shlex.quote(path) +
                   '; else systemctl show atomic-ci-' + node['phase'] +
                   '.service --property=ActiveState --property=SubState; fi')
        output = self.ssh(node_id, command)
        if output.lstrip().startswith('{'):
            result = json.loads(output)
            expected = {'batch_key': self.config['batch_key'], 'source_commit': self.config['source_commit'],
                        'node_id': node_id, 'phase': node['phase']}
            if any(result.get(key) != value for key, value in expected.items()):
                raise ValueError('phase result provenance differs from the scheduled job')
            self.update(lambda value: value['nodes'][node_id]['phase_results'].update({node['phase']: result}))
            self.node_update(node_id, status='waiting', last_result=result)
            if result['status'] != 'passed':
                if completed_phase_failure(node, result):
                    raise PhaseFailure(node_id, node['phase'], result)
                raise RuntimeError(node_id + ': ' + node['phase'] + ' failed')
            self.event(node_id + ': passed ' + node['phase'])
            return True
        if 'ActiveState=failed' in output or 'ActiveState=inactive' in output:
            raise RuntimeError(node_id + ': service ended without a result')
        return False

    def wait(self, nodes):
        waiting = set(nodes)
        while waiting:
            self.check_deadline()
            with cf.ThreadPoolExecutor(max_workers=min(35, len(waiting))) as pool:
                tasks = {pool.submit(self.observe, key): key for key in waiting}
                for future in cf.as_completed(tasks):
                    if future.result():
                        waiting.remove(tasks[future])
            if waiting:
                time.sleep(15)

    def record_phase_failure(self, error):
        failure = {'node_id': error.node_id, 'phase': error.phase,
                   'error': error.result.get('error'), 'finished_at': error.result.get('finished_at')}

        def append(state):
            failures = state.setdefault('ci_failures', [])
            if not any((item['node_id'], item['phase']) == (error.node_id, error.phase) for item in failures):
                failures.append(failure)
                failures.sort(key=lambda item: (item['node_id'], item['phase']))
        self.update(append)
        self.event(str(error) + '; continuing independent checks and browser shards')

    def run_check_queue(self, node_id, jobs):
        for name, args in jobs:
            self.phase(node_id, 'check-' + name, 'check', args)
            try:
                self.wait([node_id])
            except PhaseFailure as error:
                self.record_phase_failure(error)

    def run_browser_shard(self, node_id, builder):
        self.browser(node_id, builder)
        try:
            self.wait([node_id])
        except PhaseFailure as error:
            self.record_phase_failure(error)
            return self.verify_browser(node_id, allow_failure=True)
        return self.verify_browser(node_id)

    def finish_validation(self, nodes):
        state = self.read()
        expected = {'check-' + name for name, _ in CHECKS}
        checks = [name for node in state['nodes'].values() for name in node['phase_results'] if name in expected]
        if set(checks) != expected or len(checks) != len(expected):
            raise ValueError('selected CI checks did not complete exactly once')
        failures = state.get('ci_failures', [])
        recorded = {(item['node_id'], item['phase']) for item in failures}
        for key, node in state['nodes'].items():
            for name, result in node['phase_results'].items():
                if name in expected or (key in nodes and name == 'browser'):
                    if result.get('status') not in ('passed', 'failed'):
                        raise ValueError('selected CI phase is not complete: ' + key + ': ' + name)
                    if result['status'] == 'failed' and (key, name) not in recorded:
                        raise ValueError('selected CI phase failure was not collected: ' + key + ': ' + name)
        reports = [[tuple(item[:4]) + (tuple(item[4]),)
                    for item in state['nodes'][key]['browser_identities']] for key in nodes]
        count = verify_suite_union(state['bundle']['inventory'], reports)
        self.update(lambda value: value.update(full_browser_test_count=count, validation_completed_at=stamp()))
        if failures:
            raise CIValidationFailure('CI completed with failures: ' + '; '.join(
                item['node_id'] + ': ' + item['phase'] for item in failures))
        self.update(lambda value: value.update(validation_passed_at=stamp()))
        return count

    def source_inputs(self, nodes):
        reference = self.read().get('source_input_reference')
        for key in nodes:
            output = self.ssh(key, 'cd /opt/atomic-ci/repo && dagger call browser-source-inputs', timeout=180)
            report = json.loads(output)
            if report.get('fingerprintVersion') != 2 or not re.fullmatch(r'[0-9a-f]{64}', report.get('fingerprint', '')):
                raise ValueError('source input diagnostic has an unsupported fingerprint')
            path = self.root / key / 'source-inputs.json'
            path.write_text(json.dumps(report, indent=2) + '\n')
            self.node_update(key, source_input_fingerprint=report['fingerprint'],
                             source_input_report_sha256=file_sha256(path))
            if reference is None:
                immutable = self.root / 'source-input-reference.json'
                immutable.write_text(json.dumps(report, indent=2) + '\n')
                reference = {'node':key, 'fingerprint':report['fingerprint'], 'report_path':str(immutable)}
                self.update(lambda state:state.update(source_input_reference=reference))
            elif report['fingerprint'] != reference['fingerprint']:
                original = json.loads(Path(reference['report_path']).read_text())
                left = {item[0]:item[1:] for item in original['files']}
                right = {item[0]:item[1:] for item in report['files']}
                differences = [name for name in sorted(set(left)|set(right)) if left.get(name)!=right.get(name)]
                self.node_update(key, source_input_differences=differences)
                raise ValueError('Source inputs differ before build/browser: ' + ', '.join(differences[:40]))

    def source_preflight(self, builder, canary):
        self.source_inputs([builder, canary])
        for key in (builder, canary):
            self.phase(key, 'source-preflight', 'check', ['browser-source-inputs'], preflight=True)
        self.wait([builder, canary])
        self.source_inputs([builder, canary])

    def archive_bundle(self, builder):
        """Persist a successful build outside every temporary Droplet before tests."""
        with self.lock('bundle-archive'):
            state = self.read()
            node = state['nodes'][builder]
            result = node.get('phase_results', {}).get('build')
            if not result or result.get('status') != 'passed':
                return None
            if (result.get('source_commit') != self.config['source_commit']
                    or result.get('node_id') != builder or result.get('phase') != 'build'
                    or result.get('batch_key') != self.config['batch_key']
                    or not result.get('commands') or any(item.get('exit_code') != 0 for item in result['commands'])):
                raise ValueError('original successful build phase provenance mismatch')
            bundle = state.get('bundle') or self.read_bundle(builder)
            root = Path(self.config['artifact_archive_dir'])
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            entry = root / (self.config['source_commit'] + '-' + bundle['manifest_sha256'])
            if entry.exists():
                try:
                    validate_archive(entry, self.config['source_commit'])
                except (ValueError, OSError, json.JSONDecodeError):
                    entry.rename(entry.with_name(entry.name + '.corrupt-' + uuid.uuid4().hex))
            if not entry.exists():
                partial = root / ('.' + entry.name + '.' + uuid.uuid4().hex + '.partial')
                (partial / 'bundle').mkdir(parents=True)
                try:
                    deadline = state.get('deadline')
                    remaining = (dt.datetime.fromisoformat(deadline) - utcnow()).total_seconds() if deadline else 300
                    if remaining <= 0:
                        raise TimeoutError('deadline reached; skipping unarchived bundle network copy before cleanup')
                    self.scp(builder, ['/opt/atomic-ci/share/bundle/' + name for name in BUNDLE_FILES],
                             partial / 'bundle', download=True, timeout=min(300, remaining))
                    execution = result.get('browser_build', {})
                    receipt = execution.get('original_build')
                    if receipt is None:
                        commands = result.get('commands', [])
                        if not commands or any(item.get('exit_code') != 0 for item in commands):
                            raise ValueError('successful original build command evidence is missing')
                        receipt = {'version':1, 'source_commit':self.config['source_commit'],
                            'platform':'linux/amd64', 'build_exit_code':0,
                            'build_started_at':result['started_at'], 'build_finished_at':result['finished_at'],
                            'build_command':commands[-1]['command'], 'manifest_sha256':bundle['manifest_sha256'],
                            'origin':'observed-build-phase'}
                    (partial / 'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
                    checksum = file_sha256(partial / 'build-receipt.json')
                    if execution.get('original_build_receipt_sha256', checksum) != checksum:
                        raise ValueError('original successful build receipt checksum differs')
                    (partial / 'COMPLETED').write_text(checksum + '\n')
                    (partial / 'archive-provenance.json').write_text(json.dumps({
                        'batch_key':self.config['batch_key'], 'node':builder, 'account':node['account'],
                        'droplet_id':node.get('droplet_id'), 'build_phase':result, 'archived_at':stamp()}, indent=2))
                    validate_archive(partial, self.config['source_commit'])
                    partial.replace(entry)
                finally:
                    if partial.exists():
                        shutil.rmtree(partial)
            self.node_update(builder, bundle_archive_path=str(entry), bundle_archived_at=stamp())
            self.event('Successful browser build archived at ' + str(entry))
            return entry

    def restore_bundle(self, builder):
        root = Path(self.config['artifact_archive_dir'])
        for path in sorted(root.glob(self.config['source_commit'] + '-*')):
            try:
                validate_archive(path, self.config['source_commit'])
            except (ValueError, OSError, json.JSONDecodeError):
                continue
            entry = self.config['artifact_cache_dir'] + '/' + self.config['source_commit'] + '-linux-amd64-v1'
            partial = entry + '.' + uuid.uuid4().hex + '.partial'
            command = 'if test -e ' + shlex.quote(entry) + '; then echo existing; else mkdir -p ' + shlex.quote(partial + '/bundle') + '; fi'
            if self.ssh(builder, command).strip() == 'existing':
                return
            self.scp(builder, [path / 'bundle' / name for name in BUNDLE_FILES], partial + '/bundle/', timeout=300)
            self.scp(builder, [path / 'build-receipt.json', path / 'COMPLETED'], partial + '/')
            self.ssh(builder, 'test ! -e ' + shlex.quote(entry) + ' && mv ' + shlex.quote(partial) + ' ' + shlex.quote(entry))
            self.node_update(builder, restored_bundle_archive=str(path), bundle_restored_at=stamp())
            return

    def preserve_rust(self, checks):
        for key, node in self.read()['nodes'].items():
            if node.get('phase') == 'check-rust-test' and node.get('status') == 'running' and key in checks:
                self.event('Retaining in-flight Rust checks under the existing deadline after browser preparation failed')
                try:
                    while not checks[key].done():
                        self.check_deadline()
                        for other, current in self.read()['nodes'].items():
                            if (other != key and current.get('status') == 'waiting' and not current.get('deleted_at')
                                    and (current.get('phase_kind') != 'builder' or current.get('bundle_archived_at'))):
                                self.retrieve(other)
                                self.remove(other)
                        time.sleep(15)
                    checks[key].result()
                    self.retrieve(key)
                except Exception as error:
                    self.node_update(key, retained_rust_error=str(error))

    def read_bundle(self, builder):
        script = '''python3 - <<'PYREMOTE'
import hashlib,json,pathlib
p=pathlib.Path('/opt/atomic-ci/share/bundle')
m=p/'manifest.json'
print(json.dumps({'manifest_sha256':hashlib.sha256(m.read_bytes()).hexdigest(),
                  'manifest':json.loads(m.read_text()),
                  'inventory':json.loads((p/'test-inventory.json').read_text()),
                  'file_bytes':{f.name:f.stat().st_size for f in p.iterdir() if f.is_file()},
                  'actual_hashes':{f.name:hashlib.file_digest(f.open('rb'),'sha256').hexdigest()
                                   for f in p.iterdir() if f.is_file() and f.name!='manifest.json'}}))
PYREMOTE'''
        bundle = json.loads(self.ssh(builder, script))
        manifest = bundle['manifest']
        if manifest.get('sourceCommit') != self.config['source_commit'] or manifest.get('platform') != 'linux/amd64':
            raise ValueError('builder exported an incompatible source/platform')
        if manifest.get('files') != bundle['actual_hashes']:
            raise ValueError('builder artifact hashes differ from its manifest')
        if manifest.get('version') != 1 or not report_identities(bundle['inventory']):
            raise ValueError('builder exported an unsupported or empty bundle')
        self.update(lambda state: state.update(bundle=bundle, builder=builder))
        return bundle

    def share(self, builder, workers, files=BUNDLE_FILES, hashes=None):
        if not workers:
            return
        # Read-only chroot: a worker can fetch immutable artifacts, never log in or write.
        script = '''set -euo pipefail
id atomic-artifacts >/dev/null 2>&1 || useradd --no-create-home --shell /usr/sbin/nologin atomic-artifacts
mkdir -p /etc/ssh/authorized_keys
chmod 755 /opt /opt/atomic-ci /opt/atomic-ci/share
chown root:root /opt/atomic-ci/share
find /opt/atomic-ci/share/bundle -type d -exec chmod 755 {} +
find /opt/atomic-ci/share/bundle -type f -exec chmod 644 {} +
cat >/etc/ssh/sshd_config.d/99-atomic-artifacts.conf <<'SSHD'
Match User atomic-artifacts
    ChrootDirectory /opt/atomic-ci/share
    ForceCommand internal-sftp -R
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    DisableForwarding yes
    PermitTTY no
Match all
SSHD
sshd -t
systemctl reload ssh
'''
        self.ssh(builder, 'bash -s', input=script)
        tx_script = "python3 -c \"import pathlib; print(sum(int(p.read_text()) for p in pathlib.Path('/sys/class/net').glob('*/statistics/tx_bytes') if p.parts[-3]!='lo'))\""
        tx_start = int(self.ssh(builder, tx_script).strip())
        transfer_bytes = int(self.ssh(builder, 'du -cb ' + ' '.join('/opt/atomic-ci/share/bundle/' + name for name in files) + ' | tail -1').split()[0])
        node = self.read()['nodes'][builder]
        known_hosts = (self.root / (builder + '.known-hosts')).read_text()
        public = []
        for worker in workers:
            output = self.ssh(worker, "test ! -f /opt/atomic-ci/pull-key && ssh-keygen -q -t ed25519 -N '' -f /opt/atomic-ci/pull-key && cat /opt/atomic-ci/pull-key.pub")
            if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+[^\n]*\n?', output):
                raise ValueError('worker produced an invalid transfer public key')
            public.append('restrict ' + output.strip())
            hostfile = self.root / worker / 'builder.known-hosts'
            hostfile.write_text(known_hosts)
            self.scp(worker, [hostfile], '/opt/atomic-ci/builder.known-hosts')
        self.ssh(builder, 'cat > /etc/ssh/authorized_keys/atomic-artifacts',
                 input='\n'.join(public) + '\n')
        self.ssh(builder, 'chmod 644 /etc/ssh/authorized_keys/atomic-artifacts')
        expected = hashes or {'manifest.json':self.read()['bundle']['manifest_sha256']}

        def transfer(worker):
            self.check_deadline()
            batch = '\n'.join('get /bundle/' + name + ' /opt/atomic-ci/bundle/' + name for name in files)
            command = ['sftp', '-q', '-i', '/opt/atomic-ci/pull-key', '-o', 'BatchMode=yes',
                       '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
                       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
                       '-o', 'UserKnownHostsFile=/opt/atomic-ci/builder.known-hosts', '-b', '-',
                       'atomic-artifacts@' + node['ip']]
            script = ('set -euo pipefail\nmkdir -p /opt/atomic-ci/bundle\n' + shlex.join(command) +
                      " <<'SFTP'\n" + batch + '\nSFTP\n' +
                      ''.join('echo ' + shlex.quote(value + '  /opt/atomic-ci/bundle/' + name) +
                              ' | sha256sum --check\n' for name,value in expected.items()) +
                      'rm /opt/atomic-ci/pull-key /opt/atomic-ci/pull-key.pub\n')
            self.ssh(worker, 'bash -s', input=script, timeout=900)
            self.node_update(worker, bundle_checksums=expected, bundle_received_at=stamp(),
                             artifact_transfer_network='public-ssh', artifact_payload_bytes=transfer_bytes)
        with cf.ThreadPoolExecutor(max_workers=min(8, len(workers)) or 1) as pool:
            for future in [pool.submit(transfer, key) for key in workers]:
                future.result()
        tx_end = int(self.ssh(builder, tx_script).strip())
        self.update(lambda state:state.setdefault('artifact_transfers', []).append({
            'builder':builder, 'sender_account':node['account'], 'network':'public-ssh',
            'workers':workers, 'payload_bytes_per_worker':transfer_bytes,
            'sender_nic_tx_bytes_during_transfer':max(0,tx_end-tx_start), 'finished_at':stamp()}))

    def browser(self, node_id, builder):
        self.source_inputs([node_id])
        state = self.read()
        node = state['nodes'][node_id]
        bundle = '/opt/atomic-ci/share/bundle' if node_id == builder else '/opt/atomic-ci/bundle'
        args = ['browser-shard', '--bundle', bundle, '--expected-commit', self.config['source_commit'],
                '--manifest-sha256', state['bundle']['manifest_sha256'],
                '--shard-index', str(node['shard_index']), '--shard-count', str(state['plan']['nodes']),
                '--playwright-workers', str(self.config['workers']),
                '--playwright-retries', str(self.config['retries']),
                'export', '--path', '/opt/atomic-ci/results/browser/browser']
        self.phase(node_id, 'browser', 'browser', args)

    def retrieve(self, node_id):
        node = self.read()['nodes'][node_id]
        local = self.root / node_id
        self.ssh(node_id, 'tar -C /opt/atomic-ci -czf /tmp/atomic-ci-results.tgz results', timeout=90)
        self.scp(node_id, ['/tmp/atomic-ci-results.tgz'], local / 'results.tgz', download=True)
        with tarfile.open(local / 'results.tgz') as archive:
            for member in archive.getmembers():
                rel = PurePosixPath(member.name)
                if rel.is_absolute() or '..' in rel.parts or not rel.parts or rel.parts[0] != 'results':
                    raise ValueError('unsafe result archive path')
                if member.isfile():
                    path = local / member.name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, path.open('wb') as target:
                        shutil.copyfileobj(source, target)
        self.node_update(node_id, artifact_sha256=digest((local / 'results.tgz').read_bytes()),
                         artifacts_retrieved_at=stamp())
        return local

    def verify_browser(self, node_id, allow_failure=False):
        local = self.retrieve(node_id)
        state = self.read()
        node = state['nodes'][node_id]
        result = json.loads((local / 'results/browser/result.json').read_text())
        if result != node['phase_results']['browser']:
            raise ValueError('retrieved browser result differs from observed result')
        report = json.loads((local / 'results/browser/browser/test-results.json').read_text())
        identities = verify_browser_report(report, self.config['source_commit'], result,
                                            node['shard_index'], state['plan']['nodes'], allow_failure)
        self.node_update(node_id, browser_identities=identities, browser_completed_at=stamp(),
                         browser_stats=report.get('stats', {}), browser_passed=result['status'] == 'passed',
                         browser_verified_at=stamp() if result['status'] == 'passed' else None)
        return identities

    def remove(self, node_id):
        with self.lock(node_id):
            node = self.read()['nodes'][node_id]
            if node.get('deleted_at') or not node.get('droplet_id'):
                return
            account = self.account(node['account'])
            self.api.identity(account)
            actual = self.api.call(account, ['compute', 'droplet', 'list'])
            owned = next((item for item in actual if item['id'] == node['droplet_id']), None)
            if owned and owned['name'] != node['name']:
                raise RuntimeError('owned Droplet ID/name mismatch; refusing deletion')
            if owned:
                self.api.call(account, ['compute', 'droplet', 'delete', str(node['droplet_id']),
                                        '--force', '--http-retry-max', '0'])
            for _ in range(12):
                remaining = self.api.call(account, ['compute', 'droplet', 'list'])
                if not any(item['id'] == node['droplet_id'] for item in remaining):
                    break
                time.sleep(2)
            else:
                raise RuntimeError('owned Droplet absence not verified')
            elapsed = (utcnow() - dt.datetime.fromisoformat(node['created_at'].replace('Z', '+00:00'))).total_seconds()
            rate = node['actual_size']['price_hourly']
            self.node_update(node_id, deleted_at=stamp(), deletion_verified=True,
                             lifetime_seconds=elapsed, compute_usd=max(.01, max(60, elapsed) / 3600 * rate))

    def cleanup(self, reason='manual cleanup', successful=False):
        with self.lock('cleanup'):
            if self.read().get('finished_at') and not self.read().get('cleanup_errors'):
                return
            self._cleanup(reason, successful)

    def _cleanup(self, reason='manual cleanup', successful=False):
        self.update(lambda state: state.update(stop_requested=True, stop_reason=reason))
        with self.lock('resources'):
            self.recover_resources()
        errors = []
        for key, node in self.read()['nodes'].items():
            if node.get('phase_kind') == 'builder' and not node.get('phase_results', {}).get('build'):
                try:
                    raw = self.ssh(key, 'if test -f /opt/atomic-ci/results/build/result.json; then cat /opt/atomic-ci/results/build/result.json; fi')
                    if raw.strip():
                        result = json.loads(raw)
                        if (result.get('source_commit') == self.config['source_commit']
                                and result.get('node_id') == key and result.get('batch_key') == self.config['batch_key']):
                            self.update(lambda state:state['nodes'][key]['phase_results'].update(build=result))
                            node = self.read()['nodes'][key]
                except Exception as error:
                    self.node_update(key, bundle_backup_error=str(error))
            if node.get('phase_results', {}).get('build', {}).get('status') == 'passed':
                try:
                    self.archive_bundle(key)
                except Exception as error:
                    self.node_update(key, bundle_backup_error=str(error))
                    self.event('Successful build backup failed before bounded cleanup: ' + str(error))
        nodes = [key for key, node in self.read()['nodes'].items()
                 if node.get('droplet_id') and not node.get('deleted_at')]

        def finish(key):
            node = self.read()['nodes'][key]
            if node.get('ip'):
                try:
                    if node.get('status') == 'running':
                        self.ssh(key, 'systemctl stop atomic-ci-' + node['phase'] + '.service', timeout=30)
                    self.retrieve(key)
                except Exception as error:
                    self.node_update(key, retrieval_error=str(error))
            self.remove(key)
        with cf.ThreadPoolExecutor(max_workers=min(35, len(nodes)) or 1) as pool:
            tasks = {pool.submit(finish, key): key for key in nodes}
            for future in cf.as_completed(tasks):
                try:
                    future.result()
                except Exception as error:
                    errors.append(tasks[future] + ': ' + str(error))
        for account in self.config['accounts']:
            try:
                self.recover_keys(account)
                state = self.read()
                key = state['keys'].get(account['context'], {})
                if key.get('id'):
                    items = self.api.call(account, ['compute', 'ssh-key', 'list'])
                    owned = next((item for item in items if item['id'] == key['id']), None)
                    if owned and (owned['name'] != key['name'] or owned['fingerprint'] != key['fingerprint']):
                        raise RuntimeError('owned SSH key identity mismatch')
                    if owned:
                        self.api.call(account, ['compute', 'ssh-key', 'delete', str(key['id']), '--force'])
                    for attempt in range(12):
                        remaining = self.api.call(account, ['compute', 'ssh-key', 'list'])
                        if not any(item['id'] == key['id'] for item in remaining):
                            break
                        if attempt < 11:
                            time.sleep(2)
                    else:
                        raise RuntimeError('owned SSH key absence not verified')
                    self.update(lambda value: value['keys'][account['context']].update(deletion_verified=True))
            except Exception as error:
                errors.append(account['context'] + ': ' + str(error))
        state = self.read()
        cost = sum(node.get('compute_usd', 0) for node in state['nodes'].values())
        # NIC counters include SSH/protocol overhead and any concurrent outbound traffic.
        # Treat all of it as chargeable only for a conservative pre-pool upper estimate.
        tx_bytes = sum(item['sender_nic_tx_bytes_during_transfer'] for item in state.get('artifact_transfers', []))
        status = 'cleanup_failed' if errors else 'passed' if successful else 'stopped'
        self.update(lambda value: value.update(status=status, cleanup_errors=errors,
                    cleanup_checked_at=stamp(), estimated_compute_usd=cost,
                    artifact_egress_before_pool_upper_usd=tx_bytes / (1024 ** 3) * .01,
                    ci_elapsed_seconds=(utcnow()-dt.datetime.fromisoformat(value['first_creation_at'])).total_seconds()
                    if value.get('first_creation_at') else 0,
                    finished_at=stamp() if not errors else None))
        if not errors:
            for name in ('operator-key', 'operator-key.pub', 'doctl.yaml'):
                (self.root / name).unlink(missing_ok=True)
        if errors:
            raise RuntimeError('cleanup incomplete: ' + '; '.join(errors))
        self.event('Fleet removed; estimated compute USD ' + format(cost, '.5f'))

    def _parallel_create(self, nodes):
        with cf.ThreadPoolExecutor(max_workers=min(10, len(nodes)) or 1) as pool:
            tasks = [pool.submit(self.create, key) for key in nodes]
            try:
                for future in cf.as_completed(tasks):
                    future.result()
            except BaseException:
                self.update(lambda value:value.update(stop_requested=True))
                for task in tasks:
                    task.cancel()
                raise

    def tiny_probe(self, builder, worker):
        fixture = Path(self.config['oci_probe_dir'])
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for path in fixture.rglob('*'):
                if path.is_file() and not any(part in ('node_modules', '.git') for part in path.parts):
                    archive.add(path, arcname=str(path.relative_to(fixture)), recursive=False)
        for key in (builder, worker):
            node = self.read()['nodes'][key]
            execute(['ssh', *self.ssh_options(node), 'root@' + node['ip'],
                     'mkdir -p /opt/atomic-ci/oci-smoke && tar -C /opt/atomic-ci/oci-smoke -xzf -'],
                    input=data.getvalue(), timeout=60)
            output = self.ssh(key, 'cd /opt/atomic-ci/repo && dagger functions', timeout=300)
            (self.root / key / 'dagger-functions.log').write_text(output)
        self.phase(builder, 'probe-export', 'probe', ['prepare', 'export', '--path',
                   '/opt/atomic-ci/share/bundle'], module='/opt/atomic-ci/oci-smoke')
        self.wait([builder])
        archive_hash = self.ssh(builder, "sha256sum /opt/atomic-ci/share/bundle/client.oci.tar").split()[0]
        self.share(builder, [worker], files=('client.oci.tar',), hashes={'client.oci.tar':archive_hash})
        self.phase(worker, 'probe-import', 'probe', ['verify', '--archive',
                   '/opt/atomic-ci/bundle/client.oci.tar'], module='/opt/atomic-ci/oci-smoke')
        self.wait([worker])
        self.ssh(builder, 'rm -rf /opt/atomic-ci/share/bundle')
        self.ssh(worker, 'rm -rf /opt/atomic-ci/bundle')
        self.update(lambda state:state.update(oci_probe_passed_at=stamp()))

    def run(self):
        plan = self.plan()
        fixture = Path(self.config.get('oci_probe_dir', ''))
        if not fixture.is_absolute() or not (fixture / 'dagger.json').is_file():
            raise ValueError('oci_probe_dir must point to the reviewed portable OCI fixture')
        self.initialize(plan)
        watcher = None
        checks = {}
        check_pool = cf.ThreadPoolExecutor(max_workers=10)
        browser_pool = cf.ThreadPoolExecutor(max_workers=plan['nodes'])
        try:
            self.register_keys()
            with (self.root / 'watchdog.log').open('ab') as watcher_log:
                watcher = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--config',
                    str(self.root / 'config.json'), 'watchdog'], start_new_session=True,
                    stdout=watcher_log, stderr=subprocess.STDOUT)
            self.update(lambda state: state.update(watchdog_pid=watcher.pid, status='running'))
            node_ids = list(self.read()['nodes'])
            builder, canary = node_ids[:2]
            initial = node_ids[:min(len(node_ids), len(CHECKS) + 1)]
            self.create(builder)
            self.create(canary)
            self.tiny_probe(builder, canary)
            self.source_preflight(builder, canary)
            self.restore_bundle(builder)
            self.phase(builder, 'build', 'builder', ['prepare-browser-bundle', '--source-commit',
                self.config['source_commit'], 'export', '--path', '/opt/atomic-ci/share/bundle'])
            self._parallel_create(initial[2:])
            check_nodes = initial[1:]
            queues = {key: [] for key in check_nodes}
            for index, job in enumerate(CHECKS):
                queues[check_nodes[index % len(check_nodes)]].append(job)

            checks = {key:check_pool.submit(self.run_check_queue, key, queues[key]) for key in check_nodes}
            build = check_pool.submit(self.wait, [builder])
            # Rust may continue while the first imported browser shard validates the transport.
            while not (build.done() and checks[canary].done()):
                self.check_deadline()
                for future in [build, *checks.values()]:
                    if future.done():
                        future.result()
                time.sleep(5)
            build.result()
            checks[canary].result()
            self.read_bundle(builder)
            self.archive_bundle(builder)
            self.share(builder, [canary])
            self.run_browser_shard(canary, builder)
            self.remove(canary)
            remaining = [key for key in node_ids if key not in initial]
            self._parallel_create(remaining)
            workers = [key for key in node_ids if key not in (builder, canary)]
            self.share(builder, workers)

            def run_browser(key):
                if key in checks:
                    checks[key].result()
                self.run_browser_shard(key, builder)
                if key != builder:
                    self.remove(key)
            jobs = [browser_pool.submit(run_browser, key) for key in node_ids if key != canary]
            for future in cf.as_completed(jobs):
                future.result()
            self.finish_validation(node_ids)
            self.cleanup('all checks and complete browser suite passed', successful=True)
        except BaseException as error:
            if self.path.exists():
                self.update(lambda state:state.update(validation_error=str(error)))
                try:
                    if not isinstance(error, (KeyboardInterrupt, SystemExit)):
                        self.preserve_rust(checks)
                finally:
                    self.cleanup('controller interrupted or a phase failed')
            raise
        finally:
            check_pool.shutdown(wait=False, cancel_futures=True)
            browser_pool.shutdown(wait=False, cancel_futures=True)
            if watcher is not None and watcher.poll() is None:
                watcher.terminate()
                try:
                    watcher.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    watcher.kill()

    def watchdog(self):
        while True:
            state = self.read()
            if state.get('finished_at'):
                return
            if state.get('deadline') and utcnow() >= dt.datetime.fromisoformat(state['deadline']):
                self.cleanup('independent elapsed-time watchdog')
                return
            time.sleep(10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('command', choices=('plan', 'run', 'status', 'cleanup', 'watchdog'))
    args = parser.parse_args()
    config = validate_config(json.loads(args.config.read_text()))
    controller = Controller(config)
    if args.command == 'plan':
        print(json.dumps(controller.plan(), indent=2))
    elif args.command == 'status':
        print(json.dumps(controller.read(), indent=2))
    elif args.command == 'run':
        controller.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        saved_config = controller.root / 'config.json'
        if saved_config.exists() or controller.path.exists():
            raise ValueError('batch runtime already exists; choose a fresh batch')
        saved_config.write_text(json.dumps(config, indent=2) + '\n')
        saved_config.chmod(0o600)
        controller.run()
    elif args.command == 'cleanup':
        controller.cleanup()
    else:
        controller.watchdog()


if __name__ == '__main__':
    main()
