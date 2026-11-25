#!/usr/bin/env python3
"""Execute one immutable fan-out phase on an otherwise disposable Linux host."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

ROOT = Path('/opt/atomic-ci')
PROCESS = None
BUNDLE_CHECKS = frozenset(('js-test', 'js-typecheck', 'typedoc-publish', 'js-test-integration'))
BUNDLE_FILES = frozenset(('manifest.json', 'atomic-server-binary', 'client.oci.tar', 'checks.oci.tar', 'test-inventory.json'))


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def stop(signum, _frame):
    if PROCESS is not None:
        try:
            os.killpg(PROCESS.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    raise KeyboardInterrupt('phase interrupted by signal ' + str(signum))


def run(command, directory, log):
    global PROCESS
    with log.open('wb') as output:
        PROCESS = subprocess.Popen(command, cwd=directory,
                                   env=dict(os.environ, NETLIFY_TOKEN=''),
                                   stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            return PROCESS.wait()
        finally:
            if PROCESS.poll() is None:
                try:
                    os.killpg(PROCESS.pid, signal.SIGTERM)
                    PROCESS.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    os.killpg(PROCESS.pid, signal.SIGKILL)
                    PROCESS.wait(timeout=5)
            PROCESS = None


def check_identity(config, repo):
    if not re.fullmatch(r'[0-9a-f]{40}', config['source_commit']):
        raise ValueError('invalid source commit')
    for field in ('batch_key', 'node_id', 'phase'):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', config[field]):
            raise ValueError('invalid ' + field)
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo,
                                     text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain=v1',
                                     '--untracked-files=no'], cwd=repo, text=True)
    if actual != config['source_commit'] or dirty:
        raise ValueError('phase source identity differs from clean pinned checkout')


def check_prepared_bundle(config):
    name = config.get('phase', '').removeprefix('check-')
    if config.get('kind') != 'check' or name not in BUNDLE_CHECKS:
        return
    args = config.get('args', [])
    if not args or args[0] != 'bundle-check':
        raise ValueError('dependent CI checks require the verified prepared workspace; rebuilding is not a fallback')

    def option(flag):
        if args.count(flag) != 1 or args.index(flag) + 1 == len(args):
            raise ValueError('missing or duplicate prepared-workspace argument: ' + flag)
        return args[args.index(flag) + 1]

    bundle = Path(option('--bundle'))
    expected_hash = option('--manifest-sha256')
    if (not bundle.is_absolute() or bundle.is_symlink() or option('--expected-commit') != config['source_commit']
            or option('--check-name') != name or not re.fullmatch(r'[a-f0-9]{64}', expected_hash)):
        raise ValueError('prepared-workspace path or source identity differs from the scheduled check')
    if any(not (bundle / name).is_file() or (bundle / name).is_symlink() for name in BUNDLE_FILES):
        raise ValueError('prepared workspace is missing a regular required artifact')
    def sha256(path):
        checksum = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(chunk)
        return checksum.hexdigest()
    manifest = json.loads((bundle / 'manifest.json').read_text())
    if (sha256(bundle / 'manifest.json') != expected_hash or manifest.get('version') != 2
            or manifest.get('sourceCommit') != config['source_commit'] or manifest.get('platform') != 'linux/amd64'
            or set(manifest.get('files', {})) != BUNDLE_FILES - {'manifest.json'}
            or any(sha256(bundle / artifact) != checksum for artifact, checksum in manifest['files'].items())):
        raise ValueError('prepared-workspace manifest or required artifact hash mismatch')


def main(config_path):
    config = json.loads(config_path.read_text())
    repo = ROOT / 'repo'
    for field, default, low in (('build_jobs', 4, 1), ('rust_test_threads', 0, 0)):
        value = config.get(field, default)
        if type(value) is not int or not low <= value <= 128:
            raise ValueError('invalid ' + field)
    for field in ('test_run_key', 'cache_namespace'):
        value = config.get(field, '')
        if not isinstance(value, str) or value and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,80}', value):
            raise ValueError('invalid ' + field)
    if config.get('kind') == 'browser':
        args = config.get('args', [])
        if config.get('phase') == 'browser':
            if (not args or args[0] != 'browser-shard' or '--playwright-retries' not in args
                    or args[args.index('--playwright-retries') + 1:][:1] != ['0']):
                raise ValueError('the first browser pass must disable immediate Playwright retries')
        elif config.get('phase') == 'browser-retry':
            if not args or args[0] != 'browser-retry' or '--playwright-retries' in args:
                raise ValueError('the final retry uses the failed-only zero-retry browser entry point')
    check_identity(config, repo)
    check_prepared_bundle(config)
    results = ROOT / 'results' / config['phase']
    if results.exists():
        raise ValueError('a phase result directory already exists; use a fresh phase')
    results.mkdir(parents=True)
    began = time.monotonic()
    state = {key: config[key] for key in ('batch_key', 'node_id', 'phase', 'source_commit')}
    state.update(status='running', started_at=stamp(), commands=[])
    write_json(results / 'progress.json', state)
    namespace = config.get('cache_namespace') or config['batch_key'] + '-' + config['node_id']
    prefix = (['dagger', '-m', config['module'], 'call'] if config.get('module') else
              ['dagger', 'call', '--cache-namespace', namespace,
               '--max-build-jobs', str(config.get('build_jobs', 4)),
               '--build-jobs', str(config.get('build_jobs', 4))])
    if not config.get('module') and config.get('test_run_key'):
        prefix += ['--test-run-key', config['test_run_key']]
    try:
        if config.get('preflight'):
            commands = [[sys.executable, 'scripts/ci-browser-build.test.py'],
                        [sys.executable, 'scripts/ci-fanout.test.py'],
                        [sys.executable, 'scripts/ci-fanout-warm.test.py'],
                        ['docker', 'run', '--rm', '-v', str(repo) + ':/repo',
                         '-w', '/repo/.dagger', 'node:22-bookworm', 'sh', '-lc',
                         'corepack pnpm@10.15.1 install --frozen-lockfile && '
                         'corepack pnpm@10.15.1 test && '
                         'node --test ../scripts/table-package-cache.test.mjs']]
        else:
            commands = []
        if config['kind'] == 'builder':
            commands.append([sys.executable, str(repo / 'scripts/ci-browser-build.py'),
                '--source-commit', config['source_commit'],
                '--cache-root', config.get('artifact_cache_dir', '/var/cache/atomic-ci/browser-bundles'),
                '--output', '/opt/atomic-ci/share/bundle',
                '--receipt', str(results / 'browser-build-receipt.json'),
                '--cache-namespace', namespace,
                '--max-build-jobs', str(config.get('build_jobs', 4)),
                '--build-jobs', str(config.get('build_jobs', 4))])
        else:
            args = list(config['args'])
            threads = config.get('rust_test_threads', 0)
            if config['kind'] == 'check' and args == ['rust-test'] and threads:
                args += ['--test-threads', str(threads)]
            commands.append(prefix + args)
        for index, command in enumerate(commands):
            item = {'command': command, 'started_at': stamp()}
            state['commands'].append(item)
            write_json(results / 'progress.json', state)
            item['exit_code'] = run(command, repo, results / (str(index) + '-command.log'))
            item['finished_at'] = stamp()
            check_identity(config, repo)
            if item['exit_code'] != 0:
                raise RuntimeError('phase command exited ' + str(item['exit_code']))
        if config['kind'] == 'builder':
            state['browser_build'] = json.loads((results / 'browser-build-receipt.json').read_text())
        if config['kind'] == 'browser':
            exported = results / 'browser'
            state['browser_exit_code'] = int((exported / 'test-exit-code').read_text().strip())
            report = json.loads((exported / 'test-results.json').read_text())
            if report.get('errors'):
                raise RuntimeError('browser report contains global errors')
            if state['browser_exit_code'] != 0:
                raise RuntimeError('browser tests exited ' + str(state['browser_exit_code']))
        state['status'] = 'passed'
    except BaseException as error:
        state.update(status='cancelled' if isinstance(error, KeyboardInterrupt) else 'failed',
                     error=type(error).__name__ + ': ' + str(error))
    finally:
        state.update(finished_at=stamp(), elapsed_seconds=round(time.monotonic() - began, 3))
        write_json(results / 'progress.json', state)
        write_json(results / 'result.json', state)
    return 0 if state['status'] == 'passed' else 1


if __name__ == '__main__':
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, stop)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    sys.exit(main(parser.parse_args().config))
