#!/usr/bin/env python3
"""Execute one immutable fan-out phase on an otherwise disposable Linux host."""
from __future__ import annotations

import argparse
import datetime as dt
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


def main(config_path):
    config = json.loads(config_path.read_text())
    repo = ROOT / 'repo'
    check_identity(config, repo)
    results = ROOT / 'results' / config['phase']
    if results.exists():
        raise ValueError('a phase result directory already exists; use a fresh phase')
    results.mkdir(parents=True)
    began = time.monotonic()
    state = {key: config[key] for key in ('batch_key', 'node_id', 'phase', 'source_commit')}
    state.update(status='running', started_at=stamp(), commands=[])
    write_json(results / 'progress.json', state)
    prefix = (['dagger', '-m', config['module'], 'call'] if config.get('module') else
              ['dagger', 'call', '--cache-namespace', config['batch_key'] + '-' + config['node_id'],
               '--max-build-jobs', '4'])
    try:
        if config.get('preflight'):
            commands = [[sys.executable, 'scripts/ci-browser-build.test.py'],
                        [sys.executable, 'scripts/ci-fanout.test.py'],
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
                '--cache-namespace', config['batch_key'] + '-' + config['node_id'],
                '--max-build-jobs', '4'])
        else:
            commands.append(prefix + config['args'])
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
