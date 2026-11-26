#!/usr/bin/env python3
"""Build browser artifacts once, run independent CI checks, then fan out over DO.

Configuration and credentials stay outside the checkout. `plan` is read-only;
only `run` creates paid resources. Every operation pins an account context and
UUID, and every owned resource is recorded before another phase is launched.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import copy
import contextlib
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
import queue
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
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
BUNDLE_FILES = ('manifest.json', 'atomic-server-binary', 'client.oci.tar', 'checks.oci.tar', 'test-inventory.json')
BUNDLE_CHECKS = frozenset(('js-test', 'js-typecheck', 'typedoc-publish', 'js-test-integration'))
MUTATIONS = {'create', 'delete', 'import'}


class CommandExecutionError(RuntimeError):
    """A subprocess completed unsuccessfully, rather than a controller defect."""


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


def exported_browser_global_candidate(node, result):
    """A runner hint only; retrieved execution evidence must qualify it separately."""
    return (node.get('phase_kind') == 'browser' and node.get('phase') == 'browser'
            and result.get('status') == 'failed'
            and result.get('failure_scope') == 'completed-export-browser-global'
            and result.get('error') == 'RuntimeError: browser report contains global errors'
            and type(result.get('browser_exit_code')) is int and result['browser_exit_code'] > 0
            and bool(result.get('commands'))
            and all(type(item.get('exit_code')) is int and item['exit_code'] == 0
                    for item in result['commands']))


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def stamp():
    return utcnow().isoformat()


def safe_slug(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,80}', value)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def execute(args, timeout=120, cancel=None, **kwargs):
    if cancel is None:
        result = subprocess.run(args, capture_output=True, timeout=timeout, **kwargs)
    else:
        cutoff = time.monotonic() + timeout
        with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, **kwargs) as child:
            try:
                while True:
                    cancel()
                    remaining = cutoff - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(args, timeout)
                    try:
                        stdout, stderr = child.communicate(timeout=min(.1, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        continue
            except BaseException:
                # scp owns an ssh child too; kill/reap the whole local transfer.
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
                raise
            result = subprocess.CompletedProcess(args, child.returncode, stdout, stderr)
    if result.returncode:
        program = Path(str(args[0])).name
        error = result.stderr.decode(errors='replace') if isinstance(result.stderr, bytes) else result.stderr
        if not (error or '').strip() and program == 'doctl':
            # JSON-mode doctl reports failures on stdout. Only provider error
            # codes/details belong in logs, never a whole response or argv.
            try:
                output = result.stdout
                document = json.loads(output) if isinstance(output, (str, bytes)) and len(output) <= 65536 else None
            except (ValueError, UnicodeError):
                document = None
            entries = document.get('errors') if isinstance(document, dict) else None
            diagnostics = []
            for entry in entries[:4] if isinstance(entries, list) else []:
                if not isinstance(entry, dict):
                    continue
                fields = [str(entry[field]) for field in ('code', 'detail')
                          if type(entry.get(field)) in (str, int)]
                if fields:
                    diagnostics.append(': '.join(' '.join(field.split())[:750] for field in fields))
            error = '; '.join(diagnostics)
        raise CommandExecutionError('Command failed: ' + program + ' (exit ' + str(result.returncode) + '): '
                           + ((error or '').strip()[-1500:] or 'no diagnostic output'))
    return result.stdout


def file_sha256(path, check=None):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            if check:
                check()
            value.update(chunk)
    return value.hexdigest()


def validate_archive(path, source, check=None):
    path = Path(path)
    if path.is_symlink() or any((path / 'bundle' / name).is_symlink() for name in BUNDLE_FILES):
        raise ValueError('archive payload must be materialized regular files')
    receipt = json.loads((path / 'build-receipt.json').read_text())
    if receipt.get('version') != 1:
        raise ValueError('unsupported successful build receipt version')
    if ((path / 'COMPLETED').read_text().strip() != file_sha256(path / 'build-receipt.json', check)
            or receipt.get('source_commit') != source or receipt.get('build_exit_code') != 0):
        raise ValueError('archive does not prove a successful matching build')
    manifest = json.loads((path / 'bundle/manifest.json').read_text())
    if (manifest.get('version') != 2 or manifest.get('sourceCommit') != source or manifest.get('platform') != 'linux/amd64'
            or receipt.get('manifest_sha256') != file_sha256(path / 'bundle/manifest.json', check)
            or set(manifest.get('files', {})) != set(BUNDLE_FILES) - {'manifest.json'}):
        raise ValueError('archive manifest provenance mismatch')
    for name, expected in manifest['files'].items():
        if file_sha256(path / 'bundle' / name, check) != expected:
            raise ValueError('archive payload hash mismatch: ' + name)
    return receipt, manifest


def validate_config(config):
    if not safe_slug(config.get('batch_key')):
        raise ValueError('batch_key must be a unique safe identifier')
    if not re.fullmatch(r'[0-9a-f]{40}', config.get('source_commit', '')):
        raise ValueError('source_commit must be a full commit SHA')
    if 'absolute_deadline' in config:
        try:
            deadline = dt.datetime.fromisoformat(config['absolute_deadline'].replace('Z', '+00:00'))
        except (AttributeError, TypeError, ValueError):
            raise ValueError('absolute_deadline must be a timezone-aware ISO timestamp') from None
        if deadline.utcoffset() is None:
            raise ValueError('absolute_deadline must be a timezone-aware ISO timestamp')
    for field in ('worktree', 'runtime_dir'):
        if not Path(config.get(field, '')).is_absolute():
            raise ValueError(field + ' must be an absolute path')
    if Path(config['runtime_dir']).is_relative_to(Path(config['worktree'])):
        raise ValueError('runtime_dir must be outside the repository')
    for field, default, low, high in (('max_hours', 4, .01, 4), ('workers', 1, 1, 64),
                                     ('retries', 1, 0, 1), ('build_jobs', 4, 1, 128),
                                     ('rust_test_threads', 0, 0, 128)):
        value = config.setdefault(field, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
            raise ValueError('invalid ' + field)
        if field != 'max_hours' and not isinstance(value, int):
            raise ValueError(field + ' must be an integer')
    if type(config.setdefault('host_bundle_backup', False)) is not bool:
        raise ValueError('host_bundle_backup must be a boolean')
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


def report_cases(report):
    """Return stable identities and mutable test nodes, rejecting duplicates."""
    cases = []

    def walk(suites, parents=()):
        for suite in suites:
            path = parents + (suite.get('title', ''),)
            for spec in suite.get('specs', []):
                file = spec.get('file', suite.get('file', '')).replace('\\', '/').split('/tests/', 1)[-1]
                for test in spec.get('tests', []):
                    identity = (test.get('projectName') or test.get('projectId'), file,
                                spec.get('line'), spec.get('column'), path[1:] + (spec['title'],))
                    cases.append((identity, spec, test))
            walk(suite.get('suites', []), path)
    walk(report.get('suites', []))
    if [item[0] for item in cases] != report_identities(report):
        raise ValueError('browser report identities are inconsistent')
    return cases


def zero_retry_project(report):
    projects = report.get('config', {}).get('projects', [])
    if len(projects) != 1 or projects[0].get('retries') != 0:
        raise ValueError('fan-out requires exactly one browser project with zero immediate retries')
    name = projects[0].get('name') or projects[0].get('id')
    if not name or any(identity[0] != name for identity, _, _ in report_cases(report)):
        raise ValueError('browser report project identity differs from its configuration')
    return name


def failed_browser_cases(report):
    """Select actual completed ordinary failures, never unexpected passes or unrun tests."""
    zero_retry_project(report)
    if report.get('errors'):
        raise ValueError('browser report contains global errors')
    failed = {}
    ids = set()
    for identity, spec, test in report_cases(report):
        results = test.get('results', [])
        if any(result.get('status') == 'interrupted' for result in results):
            raise ValueError('browser execution was interrupted')
        if (test.get('status') == 'flaky' or len(results) > 1
                or any(result.get('retry', 0) != 0 for result in results)):
            raise ValueError('first browser pass contains an immediate retry')
        if (test.get('status') == 'unexpected' and test.get('expectedStatus') == 'passed'
                and len(results) == 1 and results[0].get('status') in ('failed', 'timedOut')):
            test_id = spec.get('id')
            if not isinstance(test_id, str) or not test_id or test_id in ids:
                raise ValueError('failed browser cases lack unambiguous native test IDs')
            ids.add(test_id)
            failed[identity] = test_id
    return failed


def unrun_browser_cases(report):
    result = []
    for identity, _, test in report_cases(report):
        intentional_skip = (test.get('expectedStatus') == 'skipped'
                            or any(item.get('type') in ('skip', 'fixme') for item in test.get('annotations', [])))
        if ((test.get('status') == 'skipped' and not intentional_skip)
                or (test.get('status') != 'skipped' and not test.get('results'))):
            result.append(identity)
    return result


def verify_exported_browser_global_report(report, inventory, expected_commit, result, index, count):
    """Qualify a completed export for diagnostics, never successful test coverage.

    The bundle has a full-suite inventory, not a per-shard selection. Missing
    unlisted cases are therefore checked by the exact union barrier afterwards.
    Every observable case must have one terminal result. An expected-pass case
    blocked by the global error may have a native skipped result, but remains
    explicitly unrun and fails final validation. Interrupted/absent results do
    not qualify. Missing unlisted cases also fail the later exact union gate.
    """
    if (not exported_browser_global_candidate({'phase_kind': 'browser', 'phase': 'browser'}, result)
            or result.get('source_commit') != expected_commit):
        raise ValueError('global browser failure did not complete on the pinned source')
    if not isinstance(report.get('errors'), list) or not report['errors']:
        raise ValueError('completed global browser failure lacks global errors')
    if any(not isinstance(error, dict) or not any(
            isinstance(error.get(field), str) and error[field].strip() for field in ('message', 'stack', 'value'))
           for error in report['errors']):
        raise ValueError('global browser report contains malformed global errors')
    if report.get('config', {}).get('shard') != {'current': index, 'total': count}:
        raise ValueError('browser report shard differs from the scheduled shard')
    zero_retry_project(report)
    known = {identity: spec.get('id') for identity, spec, _ in report_cases(inventory)}
    cases = report_cases(report)
    native_ids = set()
    if not cases:
        raise ValueError('global browser failure has no completed test coverage')
    for identity, spec, test in cases:
        test_id = spec.get('id')
        if (identity not in known or not isinstance(test_id, str) or not test_id
                or test_id != known[identity] or test_id in native_ids):
            raise ValueError('global browser failure has unknown or ambiguous inventory identities')
        native_ids.add(test_id)
        attempts = test.get('results', [])
        if len(attempts) != 1 or attempts[0].get('retry', 0) != 0:
            raise ValueError('global browser export has absent or retried test results')
        actual, status, expected = attempts[0].get('status'), test.get('status'), test.get('expectedStatus')
        intentional_skip = expected == 'skipped' or any(
            item.get('type') in ('skip', 'fixme') for item in test.get('annotations', []))
        blocked = status == 'skipped' and actual == 'skipped' and expected == 'passed'
        terminal = ((status == 'skipped' and actual == 'skipped' and intentional_skip) or blocked
                    or (status == 'expected' and expected in ('passed', 'failed', 'timedOut')
                        and actual == expected)
                    or (status == 'unexpected' and actual in ('passed', 'failed', 'timedOut')
                        and expected in ('passed', 'failed', 'timedOut') and actual != expected))
        if not terminal:
            raise ValueError('global browser failure contains an incomplete or inconsistent test')
    counts = browser_stats(report)
    if any(name in report.get('stats', {}) and report['stats'][name] != value for name, value in counts.items()):
        raise ValueError('global browser report counts differ from its terminal test coverage')
    return [identity for identity, _, _ in cases]


def browser_stats(report):
    counts = dict(expected=0, flaky=0, unexpected=0, skipped=0)
    for _, _, test in report_cases(report):
        status = test.get('status')
        if status not in counts:
            raise ValueError('browser report has an unknown final test status')
        counts[status] += 1
    return counts


def combined_browser_timing(reports):
    bounds = []
    for report in reports:
        stats = report.get('stats', {})
        if 'startTime' in stats and 'duration' in stats:
            began = dt.datetime.fromisoformat(stats['startTime'].replace('Z', '+00:00'))
            bounds.append((began, began + dt.timedelta(milliseconds=stats['duration'])))
    if not bounds:
        return {}
    began, ended = min(item[0] for item in bounds), max(item[1] for item in bounds)
    return {'startTime': began.isoformat(), 'duration': (ended - began).total_seconds() * 1000}


def merge_browser_retry(first, retry, result, source_commit):
    """Preserve both executions; a recovery is flaky, never a first-pass success."""
    selected = failed_browser_cases(first)
    zero_retry_project(retry)
    if retry.get('config', {}).get('shard') is not None:
        raise ValueError('deferred retry must not apply a shard to the failed-test selection')
    if retry.get('errors') or result.get('source_commit') != source_commit:
        raise ValueError('retry report global errors or source provenance mismatch')
    if result.get('status') == 'passed':
        if result.get('browser_exit_code') != 0:
            raise ValueError('retry export success is not browser success')
    elif not completed_phase_failure({'phase_kind': 'browser'}, result):
        raise ValueError('deferred retry did not complete normally')
    cases = report_cases(retry)
    if not selected or {identity for identity, _, _ in cases} != set(selected):
        raise ValueError('deferred retry identities differ from the exact failed-test selection')
    output = copy.deepcopy(first)
    targets = {identity: (spec, test) for identity, spec, test in report_cases(output)}
    recovered = []
    for identity, _, test in cases:
        attempts = test.get('results', [])
        if (test.get('expectedStatus') != 'passed' or len(attempts) != 1
                or attempts[0].get('retry', 0) != 0
                or attempts[0].get('status') not in ('passed', 'failed', 'timedOut')):
            raise ValueError('deferred retry skipped, retried or did not execute a selected test')
        passed = test.get('status') == 'expected' and attempts[0]['status'] == 'passed'
        failed = test.get('status') == 'unexpected' and attempts[0]['status'] in ('failed', 'timedOut')
        if not passed and not failed:
            raise ValueError('deferred retry test status does not match its actual execution')
        spec, original = targets[identity]
        attempt = copy.deepcopy(attempts[0])
        attempt.update(retry=1, fanoutPhase='browser-retry')
        original['results'].append(attempt)
        original['status'] = 'flaky' if passed else 'unexpected'
        if passed:
            recovered.append(identity)
        spec['ok'] = all(item.get('status') in ('expected', 'flaky', 'skipped') for item in spec.get('tests', []))
    stats = browser_stats(output)
    if (result['status'] == 'passed') != (browser_stats(retry)['unexpected'] == 0):
        raise ValueError('retry exit code and reported outcomes disagree')
    output['stats'] = dict(output.get('stats', {}), **stats, **combined_browser_timing([first, retry]))
    return output, recovered


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
        self.backup_thread = None
        self.backup_cancel = threading.Event()
        if self.path.exists() and self.read()['config'] != self.config:
            raise ValueError('configuration differs from the immutable batch state')

    @contextlib.contextmanager
    def lock(self, name, check=None):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (self.root / (name + '.lock')).open('a') as handle:
            if check is None:
                fcntl.flock(handle, fcntl.LOCK_EX)
            else:
                while True:
                    check()
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        time.sleep(.05)
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
        if self.config.get('absolute_deadline') and utcnow() >= dt.datetime.fromisoformat(
                self.config['absolute_deadline'].replace('Z', '+00:00')):
            raise TimeoutError('the authorized campaign deadline has passed')
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
        budget = {}
        if self.config.get('absolute_deadline'):
            began = utcnow()
            absolute = dt.datetime.fromisoformat(self.config['absolute_deadline'].replace('Z', '+00:00'))
            if began >= absolute:
                raise TimeoutError('the authorized campaign deadline has passed')
            budget = {'first_creation_at': began.isoformat(),
                      'deadline': min(began + dt.timedelta(hours=self.config['max_hours']), absolute).isoformat()}
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
                 'keys': {}, 'status': 'initialized', 'created_at': stamp(), 'stop_requested': False,
                 'controller_pid': os.getpid(), **budget}
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

    def artifact_transfer_timeout(self, maximum=900, allow_stopped=False):
        """Large artifacts get more transfer time, never a later batch deadline."""
        deadline = self.read().get('deadline')
        remaining = (dt.datetime.fromisoformat(deadline) - utcnow()).total_seconds() if deadline else maximum
        if remaining <= 0:
            raise TimeoutError('deadline reached; skipping artifact transfer before cleanup')
        # Cleanup intentionally preserves completed builds after stop_requested.
        # Only this bounded backup bypasses the stop flag, not the time limit.
        if not allow_stopped:
            self.check_deadline()
        return min(maximum, remaining)

    def creation_reconciled(self, attempted_at):
        """An empty provider list immediately after a lost response proves nothing."""
        return bool(attempted_at and (utcnow() - dt.datetime.fromisoformat(
            attempted_at.replace('Z', '+00:00'))).total_seconds() >= 120)

    def register_keys(self):
        public = (self.root / 'operator-key.pub').read_text().strip()
        for account in self.config['accounts']:
            self.check_deadline()
            if self.read()['keys'].get(account['context'], {}).get('creation_attempted'):
                raise RuntimeError('operator SSH key creation already attempted; reconcile instead')
            self.api.identity(account)
            name = self.config['batch_key'] + '-operator'
            existing = self.api.call(account, ['compute', 'ssh-key', 'list'])
            if any(item['name'] == name or item.get('public_key', '').strip() == public for item in existing):
                raise RuntimeError('refusing to adopt a pre-existing operator SSH key')
            self.check_deadline()
            self.update(lambda state: state['keys'].update({account['context']: {'name': name,
                        'public_key': public, 'creation_attempted': True,
                        'creation_attempted_at': stamp(), 'creation_absence_verified': True,
                        'creation_account_uuid': account['expected_uuid']}}))
            try:
                value = self.api.call(account, ['compute', 'ssh-key', 'import', name,
                                               '--public-key-file', str(self.root / 'operator-key.pub'),
                                               '--http-retry-max', '0'])
            except BaseException:
                try:
                    self.recover_keys(account)
                except Exception as error:
                    self.update(lambda state: state['keys'][account['context']].update(
                        creation_reconciliation_error=str(error)))
                raise
            value = value[0] if isinstance(value, list) else value
            self.update(lambda state: state['keys'][account['context']].update(
                id=value['id'], fingerprint=value['fingerprint']))

    def recover_keys(self, account):
        key = self.read()['keys'].get(account['context'])
        if not key:
            return
        self.api.identity(account)
        matches = [item for item in self.api.call(account, ['compute', 'ssh-key', 'list'])
                   if item['name'] == key['name'] and
                   item.get('public_key', '').strip() == key['public_key']]
        if len(matches) > 1:
            raise RuntimeError('ambiguous duplicate owned SSH keys')
        if matches:
            item = matches[0]
            if key.get('id') is not None and (key['id'] != item['id']
                    or key.get('fingerprint') != item.get('fingerprint')):
                raise RuntimeError('owned SSH key ID differs; refusing adoption')
            if key.get('id') is None and (not key.get('creation_absence_verified')
                    or key.get('creation_account_uuid') != account['expected_uuid']):
                raise RuntimeError('unknown SSH key lacks verified creation ownership')
            self.update(lambda state: state['keys'][account['context']].update(
                id=item['id'], fingerprint=item['fingerprint']))
        elif key.get('id') is None and key.get('creation_attempted'):
            if (not key.get('creation_absence_verified')
                    or key.get('creation_account_uuid') != account['expected_uuid']
                    or not self.creation_reconciled(key.get('creation_attempted_at'))):
                raise RuntimeError('SSH key import outcome pending provider reconciliation')
            self.update(lambda state: state['keys'][account['context']].update(
                creation_absence_reconciled_at=stamp()))

    def create(self, node_id):
        with self.lock('resources'):
            self.check_deadline()
            state = self.read()
            node = state['nodes'][node_id]
            if node.get('droplet_id') or node.get('creation_attempted_at'):
                raise ValueError('node creation already attempted; reconcile instead of creating again')
            if not state.get('deadline'):
                started = utcnow()
                self.update(lambda value: value.update(first_creation_at=started.isoformat(),
                    deadline=(started + dt.timedelta(hours=self.config['max_hours'])).isoformat()))
            account = self.account(node['account'])
            self.api.identity(account)
            existing = self.api.call(account, ['compute', 'droplet', 'list'])
            if any(item['name'] == node['name'] for item in existing):
                raise RuntimeError('refusing to adopt a pre-existing Droplet name')
            self.check_deadline()
            self.node_update(node_id, creation_attempted_at=stamp(),
                creation_absence_verified=True, creation_account_uuid=account['expected_uuid'])
            try:
                value = self.api.call(account, ['compute', 'droplet', 'create', node['name'],
                    '--region', self.config['region'], '--size', self.config['size'],
                    '--image', 'ubuntu-24-04-x64', '--ssh-keys', str(state['keys'][node['account']]['id']),
                    '--user-data-file', str(self.root / 'cloud-init.yaml'), '--http-retry-max', '0'])
            except BaseException:
                try:
                    self.recover_resources()
                except Exception as error:
                    self.node_update(node_id, creation_reconciliation_error=str(error))
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
        errors = []
        for account in self.config['accounts']:
            try:
                self.recover_account_resources(account)
            except Exception as error:
                errors.append(account['context'] + ': ' + str(error))
        if errors:
            raise RuntimeError('; '.join(errors))

    def recover_account_resources(self, account):
        nodes = {key: node for key, node in self.read()['nodes'].items()
                 if node['account'] == account['context'] and node.get('creation_attempted_at')
                 and not node.get('resource_only') and not node.get('deleted_at')}
        if not nodes:
            return
        self.api.identity(account)
        existing = self.api.call(account, ['compute', 'droplet', 'list'])
        errors = []
        for key, node in nodes.items():
            matches = [item for item in existing if item['name'] == node['name']]
            known = node.get('droplet_id')
            for item in matches:
                if known == item['id']:
                    continue
                # An unknown ID is owned only by a verified, unique creation
                # attempt in this account; old same-name machines stay untouched.
                try:
                    created = dt.datetime.fromisoformat(item['created_at'].replace('Z', '+00:00'))
                    attempted = dt.datetime.fromisoformat(node['creation_attempted_at'].replace('Z', '+00:00'))
                    owned = (node.get('creation_absence_verified')
                             and node.get('creation_account_uuid') == account['expected_uuid']
                             and created >= attempted - dt.timedelta(seconds=2))
                except (KeyError, TypeError, ValueError):
                    owned = False
                if not owned:
                    errors.append(key + ': unknown Droplet lacks verified creation ownership')
                    continue
                if known is None:
                    self.record_resource(key, item)
                    known = item['id']
                else:
                    extra = key + '-duplicate-' + str(item['id'])
                    self.update(lambda value: value['nodes'].update({extra: {
                        **value['nodes'][key], 'id': extra, 'droplet_id': item['id'],
                        'created_at': item['created_at'], 'actual_size': item['size'],
                        'resource_only': True, 'status': 'ambiguous-create'}}))
            if known is None and not matches:
                if (node.get('creation_absence_verified')
                        and node.get('creation_account_uuid') == account['expected_uuid']
                        and self.creation_reconciled(node['creation_attempted_at'])):
                    self.node_update(key, creation_absence_reconciled_at=stamp())
                else:
                    errors.append(key + ': Droplet create outcome pending provider reconciliation')
        if errors:
            raise RuntimeError('; '.join(errors))

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

    def scp(self, node_id, sources, destination, download=False, timeout=180, cancel=None):
        node = self.read()['nodes'][node_id]
        remote = 'root@' + node['ip'] + ':'
        args = ([remote + str(source) for source in sources] + [str(destination)] if download else
                [str(source) for source in sources] + [remote + str(destination)])
        return execute(['scp', *self.ssh_options(node), *args], timeout=timeout, text=True, cancel=cancel)

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
                if completed_phase_failure(node, result) or exported_browser_global_candidate(node, result):
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
        if error.result.get('failure_scope'):
            failure['failure_scope'] = error.result['failure_scope']

        def append(state):
            failures = state.setdefault('ci_failures', [])
            if not any((item['node_id'], item['phase']) == (error.node_id, error.phase) for item in failures):
                failures.append(failure)
                failures.sort(key=lambda item: (item['node_id'], item['phase']))
        self.update(append)
        self.event(str(error) + '; continuing independent checks and browser shards')

    def run_check_queue(self, node_id, jobs):
        # Keep shared-queue generators lazy; sorting one would claim every job
        # for a single worker. Finite per-node queues can safely prioritize setup.
        if isinstance(jobs, (list, tuple)):
            jobs = sorted(jobs, key=lambda item: item[0] in BUNDLE_CHECKS)
        for name, args in jobs:
            self.check_deadline()
            if self.read().get('validation_error'):
                raise RuntimeError('CI setup failed before another check could start')
            if name in BUNDLE_CHECKS:
                args = self.bundle_check_args(node_id, name)
            self.phase(node_id, 'check-' + name, 'check', args)
            try:
                self.wait([node_id])
            except PhaseFailure as error:
                self.record_phase_failure(error)

    def new_check_queue(self):
        pending = queue.Queue()
        for job in sorted(CHECKS, key=lambda item: item[0] in BUNDLE_CHECKS):
            pending.put(job)
        return pending

    def run_check_worker(self, node_id, pending):
        while True:
            self.check_deadline()
            try:
                job = pending.get_nowait()
            except queue.Empty:
                return
            self.run_check_queue(node_id, [job])

    def bundle_check_args(self, node_id, name):
        if name not in BUNDLE_CHECKS:
            raise ValueError('unsupported prepared-workspace check')
        while True:
            self.check_deadline()
            state = self.read()
            if state.get('validation_error'):
                raise RuntimeError('CI bundle preparation failed before dependent checks')
            prepared = state['nodes'][node_id].get('prepared_bundle')
            if prepared:
                if (prepared.get('source_commit') != self.config['source_commit']
                        or prepared.get('manifest_sha256') != state['bundle']['manifest_sha256']):
                    raise ValueError('prepared check bundle differs from the pinned source or manifest')
                return ['bundle-check', '--bundle', prepared['path'],
                        '--expected-commit', self.config['source_commit'],
                        '--manifest-sha256', prepared['manifest_sha256'], '--check-name', name,
                        '--netlify-auth-token', 'env://NETLIFY_TOKEN']
            time.sleep(1)

    def run_browser_shard(self, node_id, builder):
        self.browser(node_id, builder)
        try:
            self.wait([node_id])
        except PhaseFailure as error:
            identities = self.verify_browser(node_id, allow_failure=True)
            self.record_phase_failure(error)
            return identities
        return self.verify_browser(node_id)

    def validate_first_pass(self, nodes):
        """Barrier: all independent checks and every original browser shard finished."""
        state = self.read()
        if len(set(nodes)) != state['plan']['nodes'] or len(nodes) != len(set(nodes)):
            raise ValueError('first-pass barrier requires all distinct scheduled browser shards')
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
        reports = []
        first_failed, unrun = [], []
        for key in nodes:
            node = state['nodes'][key]
            report = self.read_browser_report(key)
            if node.get('browser_global_failure_verified_at'):
                identities = self.verify_exported_browser_global(key, report, node['phase_results']['browser'])
            else:
                identities = verify_browser_report(report, self.config['source_commit'], node['phase_results']['browser'],
                                                   node['shard_index'], state['plan']['nodes'], allow_failure=True)
                failed_browser_cases(report)
            reports.append(identities)
            first_failed.extend(identity for identity, _, test in report_cases(report) if test['status'] == 'unexpected')
            unrun.extend(unrun_browser_cases(report))
        count = verify_suite_union(state['bundle']['inventory'], reports)
        def record(value):
            value.update(full_browser_test_count=count, browser_first_failed_identities=first_failed,
                         browser_unrun_identities=unrun)
            value.setdefault('first_pass_completed_at', stamp())
        self.update(record)
        return count

    def read_browser_report(self, node_id, phase='browser'):
        path = self.root / node_id / 'results' / phase / 'browser/test-results.json'
        return json.loads(path.read_text())

    def verify_browser_receipt(self, node_id, phase, kind):
        state = self.read()
        node = state['nodes'][node_id]
        root = self.root / node_id / 'results' / phase / 'browser'
        receipt = json.loads((root / 'browser-run.json').read_text())
        expected = {'version': 1, 'kind': kind, 'sourceCommit': self.config['source_commit'],
                    'manifestSha256': state['bundle']['manifest_sha256'], 'shardIndex': node['shard_index'],
                    'shardCount': state['plan']['nodes'], 'playwrightRetries': 0}
        if any(receipt.get(key) != value for key, value in expected.items()):
            raise ValueError('browser execution receipt identity differs from the scheduled run')
        for field, name in [('reportSha256', 'test-results.json'),
                            ('lastRunSha256', 'test-results/.last-run.json'), ('exitCodeSha256', 'test-exit-code')]:
            if receipt.get(field) != file_sha256(root / name):
                raise ValueError('browser execution receipt artifact hash mismatch: ' + name)
        result = node['phase_results'][phase]
        if int((root / 'test-exit-code').read_text()) != result.get('browser_exit_code'):
            raise ValueError('browser execution exit artifact differs from observed phase result')
        return receipt

    def verify_exported_browser_global(self, node_id, report, result):
        state = self.read()
        node = state['nodes'][node_id]
        self.verify_browser_receipt(node_id, 'browser', 'browser-first-pass')
        identities = verify_exported_browser_global_report(report, state['bundle']['inventory'],
            self.config['source_commit'], result, node['shard_index'], state['plan']['nodes'])
        path = self.root / node_id / 'results/browser/browser/test-results/.last-run.json'
        native = json.loads(path.read_text())
        unrun = set(unrun_browser_cases(report))
        failed_ids = [spec['id'] for identity, spec, test in report_cases(report)
                      if test['status'] == 'unexpected' or identity in unrun]
        if (native.get('status') != 'failed' or not isinstance(native.get('failedTests'), list)
                or sorted(native['failedTests']) != sorted(failed_ids)):
            raise ValueError('global browser native last-run differs from its terminal report')
        return identities

    def browser_retry(self, node_id, builder):
        self.source_inputs([node_id])
        state = self.read()
        node = state['nodes'][node_id]
        if 'browser-retry' in node['phase_results']:
            raise ValueError('the final browser retry round has already been attempted')
        bundle = '/opt/atomic-ci/share/bundle' if node_id == builder else '/opt/atomic-ci/bundle'
        self.phase(node_id, 'browser-retry', 'browser', [
            'browser-retry', '--bundle', bundle, '--expected-commit', self.config['source_commit'],
            '--manifest-sha256', state['bundle']['manifest_sha256'],
            '--first-run', '/opt/atomic-ci/results/browser/browser',
            '--shard-index', str(node['shard_index']), '--shard-count', str(state['plan']['nodes']),
            '--playwright-workers', str(self.config['workers']),
            'export', '--path', '/opt/atomic-ci/results/browser-retry/browser'])

    def run_browser_retry(self, node_id, builder):
        self.verify_browser_receipt(node_id, 'browser', 'browser-first-pass')
        self.browser_retry(node_id, builder)
        try:
            self.wait([node_id])
        except PhaseFailure as error:
            self.record_phase_failure(error)
        self.retrieve(node_id)
        state = self.read()
        node = state['nodes'][node_id]
        root = self.root / node_id / 'results/browser-retry'
        result = json.loads((root / 'result.json').read_text())
        if result != node['phase_results']['browser-retry']:
            raise ValueError('retrieved retry result differs from observed phase result')
        first_receipt = self.verify_browser_receipt(node_id, 'browser', 'browser-first-pass')
        self.verify_browser_receipt(node_id, 'browser-retry', 'browser-deferred-retry')
        first = self.read_browser_report(node_id)
        retry = self.read_browser_report(node_id, 'browser-retry')
        selection = json.loads((root / 'browser/retry-selection.json').read_text())
        expected = {'version': 1, 'kind': 'browser-deferred-retry-selection',
                    'sourceCommit': self.config['source_commit'], 'manifestSha256': state['bundle']['manifest_sha256'],
                    'shardIndex': node['shard_index'], 'shardCount': state['plan']['nodes'],
                    'firstReportSha256': first_receipt['reportSha256'],
                    'firstLastRunSha256': first_receipt['lastRunSha256'],
                    'firstExitCodeSha256': first_receipt['exitCodeSha256']}
        selected = selection.get('failedTestIds', [])
        if (any(selection.get(key) != value for key, value in expected.items())
                or not isinstance(selected, list) or any(not isinstance(item, str) for item in selected)
                or len(selected) != len(set(selected))
                or set(selected) != set(failed_browser_cases(first).values())):
            raise ValueError('deferred retry selection receipt differs from the original failed tests')
        merged, recovered = merge_browser_retry(first, retry, result, self.config['source_commit'])
        merged_root = self.root / node_id / 'results/browser-merged'
        merged_root.mkdir(exist_ok=True)
        (merged_root / 'test-results.json').write_text(json.dumps(merged, indent=2) + '\n')
        self.node_update(node_id, browser_recovered_identities=recovered,
                         browser_retry_report_path=str(root / 'browser/test-results.json'),
                         browser_merged_report_path=str(merged_root / 'test-results.json'))
        self.event(node_id + ': final browser retry recovered ' + str(len(recovered)) + ' test(s) as flaky')

    def retry_failed_browser_shards(self, nodes, builder=None):
        self.validate_first_pass(nodes)
        state = self.read()
        if state.get('browser_retry_finished_at'):
            return
        if state.get('browser_retry_started_at'):
            raise ValueError('an interrupted final retry round cannot be started again')
        retry_nodes = [key for key in nodes if not state['nodes'][key].get('browser_global_failure_verified_at')
                       and failed_browser_cases(self.read_browser_report(key))]
        if not self.config['retries']:
            retry_nodes = []
        if retry_nodes:
            self.check_deadline()
        selected = [identity for key in retry_nodes for identity in failed_browser_cases(self.read_browser_report(key))]
        self.update(lambda value: value.update(browser_retry_started_at=stamp(), browser_retry_nodes=retry_nodes,
                                              browser_retry_attempted_identities=selected))
        with cf.ThreadPoolExecutor(max_workers=max(1, len(retry_nodes))) as pool:
            jobs = [pool.submit(self.run_browser_retry, key, builder or state['builder']) for key in retry_nodes]
            for job in cf.as_completed(jobs):
                job.result()
        self.update(lambda value: value.update(browser_retry_finished_at=stamp()))

    def finish_validation(self, nodes):
        self.retry_failed_browser_shards(nodes)
        state = self.read()
        merged = None
        completed_reports = []
        flaky, remaining, unrun, intentional_skipped = [], [], [], []
        global_errors = []
        failed_nodes = set()
        counts = dict(expected=0, flaky=0, unexpected=0, skipped=0)
        for key in nodes:
            node = state['nodes'][key]
            path = node.get('browser_merged_report_path')
            report = json.loads(Path(path).read_text()) if path else self.read_browser_report(key)
            completed_reports.append(report)
            for error in report.get('errors', []):
                global_errors.append({'node_id': key, 'shard_index': node['shard_index'],
                    'shard_count': state['plan']['nodes'], 'source_commit': self.config['source_commit'],
                    'manifest_sha256': state['bundle']['manifest_sha256'],
                    'report_path': str(self.root / key / 'results/browser/browser/test-results.json'),
                    'error': copy.deepcopy(error)})
            if report.get('errors'):
                failed_nodes.add(key)
            cases = report_cases(report)
            flaky.extend(identity for identity, _, test in cases if test['status'] == 'flaky')
            remaining.extend(identity for identity, _, test in cases if test['status'] == 'unexpected')
            local_unrun = unrun_browser_cases(report)
            unrun.extend(local_unrun)
            intentional_skipped.extend(identity for identity, _, test in cases
                                       if test['status'] == 'skipped' and identity not in local_unrun)
            if browser_stats(report)['unexpected']:
                failed_nodes.add(key)
            for _, _, test in cases:
                for attempt in test.get('results', []):
                    phase = attempt.get('fanoutPhase', 'browser')
                    raw = self.root / key / 'results' / phase / 'browser'
                    attempt.update(fanoutPhase=phase, fanoutReportPath=str(raw / 'test-results.json'))
                    for attachment in attempt.get('attachments', []):
                        original = attachment.get('path', '')
                        if '/test-results/' in original:
                            candidate = raw / 'test-results' / original.split('/test-results/', 1)[1]
                            if candidate.is_file():
                                attachment['path'] = str(candidate)
            local = self.root / key / 'results/browser-merged'
            local.mkdir(exist_ok=True)
            local_path = local / 'test-results.json'
            local_path.write_text(json.dumps(report, indent=2) + '\n')
            self.node_update(key, browser_merged_report_path=str(local_path))
            for name, count in browser_stats(report).items():
                counts[name] += count
            if merged is None:
                merged = copy.deepcopy(report)
                merged['suites'] = []
                merged['config']['shard'] = None
            merged['suites'].extend(copy.deepcopy(report['suites']))
        merged['stats'] = dict(merged.get('stats', {}), **counts, **combined_browser_timing(completed_reports))
        merged['errors'] = [dict(item['error'], fanout={key: value for key, value in item.items() if key != 'error'})
                            if isinstance(item['error'], dict) else {'message': str(item['error']), 'fanout': item}
                            for item in global_errors]
        merged['fanout'] = {'sourceCommit': self.config['source_commit'],
                            'manifestSha256': state['bundle']['manifest_sha256'],
                            'firstPassCompletedAt': state['first_pass_completed_at'],
                            'retryCompletedAt': state['browser_retry_finished_at'],
                            'timing': 'wall-clock span of all browser attempts, including time waiting for the final-round barrier',
                            'rawReportsPreserved': True, 'unrunIdentities': unrun,
                            'intentionalSkippedIdentities': intentional_skipped,
                            'globalErrors': global_errors}
        path = self.root / 'browser-merged.json'
        path.write_text(json.dumps(merged, indent=2) + '\n')
        unresolved = [item for item in state.get('ci_failures', [])
                      if item['phase'] not in ('browser', 'browser-retry') or item['node_id'] in failed_nodes]
        self.update(lambda value: value.update(browser_result_stats=counts, browser_flaky_identities=flaky,
                    browser_remaining_failed_identities=remaining, browser_unrun_identities=unrun,
                    browser_intentional_skipped_identities=intentional_skipped,
                    browser_merged_report_path=str(path), unresolved_ci_failures=unresolved,
                    browser_global_errors=global_errors,
                    validation_completed_at=stamp()))
        if unresolved or remaining or unrun or global_errors:
            raise CIValidationFailure('CI completed with failures: ' + '; '.join(
                item['node_id'] + ': ' + item['phase'] for item in unresolved)
                + ('; unexecuted browser tests=' + str(len(unrun)) if unrun else ''))
        self.update(lambda value: value.update(validation_passed_at=stamp()))
        return state['full_browser_test_count']

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

    def start_bundle_backup(self, builder):
        """Optional laptop backup never sits between verified sharing and tests."""
        if self.backup_thread is not None:
            raise RuntimeError('bundle backup already started')
        self.node_update(builder, bundle_backup_status='running', bundle_backup_started_at=stamp())
        def backup():
            try:
                archived = self.archive_bundle(builder)
                if archived is None:
                    raise RuntimeError('no successful build archive was produced')
                self.node_update(builder, bundle_backup_status='completed')
            except Exception as error:
                self.node_update(builder, bundle_backup_status='failed', bundle_backup_error=str(error),
                                 bundle_backup_fatal=not isinstance(error, (OSError, subprocess.SubprocessError, cf.CancelledError)))
            finally:
                self.node_update(builder, bundle_backup_finished_at=stamp())
        self.backup_thread = threading.Thread(target=backup, name='optional-bundle-backup')
        self.backup_thread.start()

    def stop_bundle_backup(self, raise_fatal=False):
        # Lock waits, SCP and payload hashing all observe this cancellation.
        self.backup_cancel.set()
        if self.backup_thread is not None:
            self.backup_thread.join()
        if raise_fatal:
            for node in self.read()['nodes'].values():
                if node.get('bundle_backup_fatal'):
                    raise ValueError('bundle backup provenance failed: ' + node['bundle_backup_error'])

    def archive_bundle(self, builder):
        """Make a validated optional archive within 120s and the original deadline."""
        cutoff = time.monotonic() + 120
        def check():
            state = self.read()
            if self.backup_cancel.is_set() or state.get('stop_requested'):
                raise cf.CancelledError('optional bundle backup cancelled for cleanup')
            remaining = cutoff - time.monotonic()
            if state.get('deadline'):
                remaining = min(remaining, (dt.datetime.fromisoformat(state['deadline']) - utcnow()).total_seconds())
            if remaining <= 0:
                raise TimeoutError('optional bundle backup deadline reached')
            return remaining
        with self.lock('bundle-archive', check):
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
            bundle = state.get('bundle')
            if not bundle:
                raise ValueError('bundle backup requires an already verified build manifest')
            root = Path(self.config['artifact_archive_dir'])
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            entry = root / (self.config['source_commit'] + '-' + bundle['manifest_sha256'])
            if entry.exists():
                try:
                    validate_archive(entry, self.config['source_commit'], check)
                except (ValueError, OSError, json.JSONDecodeError) as error:
                    if isinstance(error, TimeoutError):
                        raise
                    entry.rename(entry.with_name(entry.name + '.corrupt-' + uuid.uuid4().hex))
            if not entry.exists():
                partial = root / ('.' + entry.name + '.' + uuid.uuid4().hex + '.partial')
                (partial / 'bundle').mkdir(parents=True)
                try:
                    timeout = check()
                    try:
                        self.scp(builder, ['/opt/atomic-ci/share/bundle/' + name for name in BUNDLE_FILES],
                                 partial / 'bundle', download=True, timeout=timeout, cancel=check)
                    except CommandExecutionError as error:
                        # Only an actual failed backup command becomes optional
                        # IO; arbitrary controller RuntimeError stays fatal.
                        raise OSError('optional bundle transfer failed: ' + str(error)) from error
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
                    checksum = file_sha256(partial / 'build-receipt.json', check)
                    if execution.get('original_build_receipt_sha256', checksum) != checksum:
                        raise ValueError('original successful build receipt checksum differs')
                    (partial / 'COMPLETED').write_text(checksum + '\n')
                    (partial / 'archive-provenance.json').write_text(json.dumps({
                        'batch_key':self.config['batch_key'], 'node':builder, 'account':node['account'],
                        'droplet_id':node.get('droplet_id'), 'build_phase':result, 'archived_at':stamp()}, indent=2))
                    validate_archive(partial, self.config['source_commit'], check)
                    check()
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
            entry = self.config['artifact_cache_dir'] + '/' + self.config['source_commit'] + '-linux-amd64-v2'
            partial = entry + '.' + uuid.uuid4().hex + '.partial'
            command = 'if test -e ' + shlex.quote(entry) + '; then echo existing; else mkdir -p ' + shlex.quote(partial + '/bundle') + '; fi'
            if self.ssh(builder, command, timeout=self.artifact_transfer_timeout(45)).strip() == 'existing':
                return
            self.scp(builder, [path / 'bundle' / name for name in BUNDLE_FILES], partial + '/bundle/',
                     timeout=self.artifact_transfer_timeout())
            self.scp(builder, [path / 'build-receipt.json', path / 'COMPLETED'], partial + '/',
                     timeout=self.artifact_transfer_timeout(180))
            self.ssh(builder, 'test ! -e ' + shlex.quote(entry) + ' && mv ' + shlex.quote(partial) + ' ' + shlex.quote(entry),
                     timeout=self.artifact_transfer_timeout(45))
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
if any(f.is_symlink() or not f.is_file() for f in p.iterdir()):
    raise ValueError('bundle artifacts must be regular files')
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
        if (manifest.get('version') != 2 or set(manifest.get('files', {})) != set(BUNDLE_FILES) - {'manifest.json'}
                or set(bundle['file_bytes']) != set(BUNDLE_FILES) or not report_identities(bundle['inventory'])):
            raise ValueError('builder exported an unsupported or empty bundle')
        self.update(lambda state: state.update(bundle=bundle, builder=builder))
        self.node_update(builder, prepared_bundle={'path': '/opt/atomic-ci/share/bundle',
                         'source_commit': self.config['source_commit'], 'manifest_sha256': bundle['manifest_sha256']})
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
        state = self.read()
        expected = hashes or {'manifest.json': state['bundle']['manifest_sha256'], **state['bundle']['actual_hashes']}

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
            if files == BUNDLE_FILES and hashes is None:
                self.node_update(worker, prepared_bundle={'path': '/opt/atomic-ci/bundle',
                    'source_commit': self.config['source_commit'],
                    'manifest_sha256': state['bundle']['manifest_sha256']})
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
                '--playwright-retries', '0',
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
        global_failure = allow_failure and exported_browser_global_candidate(node, result)
        if global_failure:
            self.check_deadline()
            identities = self.verify_exported_browser_global(node_id, report, result)
            # Runner hints and reports cannot replace the controller's own
            # post-execution source fingerprint check before canary expansion.
            self.source_inputs([node_id])
            self.check_deadline()
            unrun = unrun_browser_cases(report)
            self.node_update(node_id, browser_global_failure_verified_at=stamp(),
                             browser_global_unrun_identities=unrun,
                             browser_global_has_unrun_cases=bool(unrun))
        else:
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
            if owned and (owned['name'] != node['name']
                    or owned.get('created_at') != node['created_at']):
                raise RuntimeError('owned Droplet ID/name mismatch; refusing deletion')
            if not owned and not self.creation_reconciled(node.get('creation_attempted_at') or node.get('created_at')):
                raise RuntimeError('owned Droplet absence pending provider reconciliation')
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
        self.stop_bundle_backup()
        errors = []
        with self.lock('resources'):
            try:
                self.recover_resources()
            except Exception as error:
                errors.append('resource reconciliation: ' + str(error))
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
                    if not owned and not key.get('deletion_verified') and not self.creation_reconciled(key.get('creation_attempted_at')):
                        raise RuntimeError('owned SSH key absence pending provider reconciliation')
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
        check_pool = cf.ThreadPoolExecutor(max_workers=len(CHECKS) + 1)
        browser_pool = cf.ThreadPoolExecutor(max_workers=plan['nodes'])
        try:
            with (self.root / 'watchdog.log').open('ab') as watcher_log:
                watcher = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--config',
                    str(self.root / 'config.json'), 'watchdog'], start_new_session=True,
                    stdout=watcher_log, stderr=subprocess.STDOUT)
            self.update(lambda state: state.update(watchdog_pid=watcher.pid, status='running'))
            self.register_keys()
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
            pending = self.new_check_queue()
            checks = {key:check_pool.submit(self.run_check_worker, key, pending) for key in check_nodes}
            build = check_pool.submit(self.wait, [builder])
            # Independent checks overlap the one build. Bundle-dependent workers
            # may wait, so never wait for their queues before publishing it.
            while not build.done():
                self.check_deadline()
                for future in [build, *checks.values()]:
                    if future.done():
                        future.result()
                time.sleep(5)
            build.result()
            self.read_bundle(builder)
            self.share(builder, check_nodes)
            checks[builder] = check_pool.submit(self.run_check_worker, builder, pending)
            # Keep the prepared bundle on DO for peer distribution. Downloading
            # a laptop cache is explicit opt-in; existing archives may restore.
            if self.config['host_bundle_backup']:
                self.start_bundle_backup(builder)
            else:
                self.node_update(builder, bundle_backup_status='disabled')

            def run_browser(key):
                if key in checks:
                    checks[key].result()
                self.run_browser_shard(key, builder)
                if (key != builder and (not self.config['retries']
                        or self.read()['nodes'][key]['phase_results']['browser']['status'] == 'passed')):
                    self.remove(key)
            jobs = [browser_pool.submit(run_browser, key) for key in initial if key != canary]
            checks[canary].result()
            self.run_browser_shard(canary, builder)
            if not self.config['retries'] or self.read()['nodes'][canary]['phase_results']['browser']['status'] == 'passed':
                self.remove(canary)
            remaining = [key for key in node_ids if key not in initial]
            self._parallel_create(remaining)
            self.share(builder, remaining)
            jobs.extend(browser_pool.submit(run_browser, key) for key in remaining)
            for future in cf.as_completed(jobs):
                future.result()
            self.stop_bundle_backup(raise_fatal=True)
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
            # A failed cleanup still owns paid resources or an unresolved API
            # outcome. Its independent watchdog must outlive this controller.
            complete = (self.path.exists() and self.read().get('finished_at')
                        and not self.read().get('cleanup_errors'))
            if complete and watcher is not None and watcher.poll() is None:
                watcher.terminate()
                try:
                    watcher.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    watcher.kill()

    def watchdog_step(self):
        state = self.read()
        if state.get('finished_at') and not state.get('cleanup_errors'):
            return True
        owner_dead = False
        if state.get('controller_pid'):
            try:
                os.kill(state['controller_pid'], 0)
            except ProcessLookupError:
                owner_dead = True
            except PermissionError:
                pass
        expired = state.get('deadline') and utcnow() >= dt.datetime.fromisoformat(state['deadline'])
        if state.get('cleanup_errors') or state.get('stop_requested') or owner_dead or expired:
            self.cleanup('independent cleanup watchdog')
        state = self.read()
        return bool(state.get('finished_at')) and not state.get('cleanup_errors')

    def watchdog(self):
        while True:
            try:
                if self.watchdog_step():
                    return
            except Exception as error:
                self.event('Independent cleanup watchdog will retry: ' + str(error))
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
