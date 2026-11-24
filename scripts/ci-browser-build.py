#!/usr/bin/env python3
"""Publish a verified browser bundle, reusing only completed host artifacts.

The host directory may be a pre-mounted persistent volume. This helper never
creates cloud storage and never treats a Dagger operation-cache hit as proof
that exported artifacts still exist.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid

FILES = ('manifest.json', 'atomic-server-binary', 'client.oci.tar', 'test-inventory.json')


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha256(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


@contextlib.contextmanager
def locked(path):
    with path.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def invoke(command, capture=False):
    result = subprocess.run(command, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout if capture else None


def validate(bundle, source, prefix, run):
    if bundle.is_symlink() or any(not (bundle / name).is_file() or (bundle / name).is_symlink()
                                  for name in FILES):
        raise ValueError('bundle must contain regular, materialized artifact files')
    manifest_hash = sha256(bundle / 'manifest.json')
    result = json.loads(run(prefix + ['validate-browser-bundle', '--bundle', str(bundle),
        '--expected-commit', source, '--manifest-sha256', manifest_hash], capture=True))
    if (result.get('sourceCommit') != source or result.get('manifestSha256') != manifest_hash
            or result.get('kind') != 'browser-bundle-validation'):
        raise ValueError('validator receipt differs from the requested source or manifest')
    return result


def completed(entry, source):
    if entry.is_symlink() or any((entry / name).is_symlink() for name in ('COMPLETED', 'build-receipt.json')):
        raise ValueError('completed cache entries and receipts must not be symlinks')
    receipt_path = entry / 'build-receipt.json'
    receipt_hash = sha256(receipt_path)
    if (entry / 'COMPLETED').read_text().strip() != receipt_hash:
        raise ValueError('completed marker differs from original build receipt')
    receipt = json.loads(receipt_path.read_text())
    if (receipt.get('version') != 1 or receipt.get('source_commit') != source
            or receipt.get('build_exit_code') != 0
            or receipt.get('manifest_sha256') != sha256(entry / 'bundle/manifest.json')):
        raise ValueError('cache entry does not prove a successful matching build')
    return receipt, receipt_hash


def materialize(bundle, output, source, prefix, run):
    """Hard links are real files inside the SFTP chroot; symlinks are not."""
    output.parent.mkdir(parents=True, exist_ok=True)
    lock_name = '.publish-' + hashlib.sha256(str(output).encode()).hexdigest()[:16] + '.lock'
    with locked(output.parent / lock_name):
        if output.exists():
            try:
                result = validate(output, source, prefix, run)
                if result['manifestSha256'] == sha256(bundle / 'manifest.json'):
                    return
            except (ValueError, OSError, subprocess.CalledProcessError, json.JSONDecodeError):
                pass
        if output.exists() and not output.is_symlink():
            if not output.is_dir() or set(path.name for path in output.iterdir()) != set(FILES):
                raise ValueError('refusing to replace an output containing unrecognized files')
        temporary = output.with_name('.' + output.name + '.' + uuid.uuid4().hex + '.partial')
        temporary.mkdir()
        try:
            for name in FILES:
                try:
                    os.link(bundle / name, temporary / name)
                except OSError:
                    # A persistent volume may be a different filesystem. GNU cp
                    # reflinks when possible; its bytes-copy fallback is explicit.
                    copied = subprocess.run(['cp', '--reflink=auto', '-a', '--', str(bundle / name),
                                             str(temporary / name)], capture_output=True)
                    if copied.returncode:
                        shutil.copy2(bundle / name, temporary / name)
            validate(temporary, source, prefix, run)
            if output.is_symlink():
                output.unlink()
            elif output.exists():
                shutil.rmtree(output)
            temporary.replace(output)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)


def ensure_bundle(source, cache_root, output, prefix, run=invoke):
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('source must be a full commit SHA')
    cache_root, output = Path(cache_root), Path(output)
    if not cache_root.is_absolute() or not output.is_absolute():
        raise ValueError('cache and published output paths must be absolute')
    cache_root, output = cache_root.resolve(), output.absolute()
    resolved_output = output.resolve()
    if (resolved_output == cache_root or resolved_output.is_relative_to(cache_root)
            or cache_root.is_relative_to(resolved_output)):
        raise ValueError('published output and cache directories must not overlap')
    cache_root.mkdir(parents=True, exist_ok=True)
    entry = cache_root / (source + '-linux-amd64-v1')
    with locked(cache_root / (entry.name + '.lock')):
        status = 'cached'
        try:
            receipt, receipt_hash = completed(entry, source)
            validation = validate(entry / 'bundle', source, prefix, run)
        except (ValueError, OSError, subprocess.CalledProcessError, json.JSONDecodeError):
            status = 'built'
            partial = cache_root / ('.' + entry.name + '.' + uuid.uuid4().hex + '.partial')
            partial.mkdir()
            started = now()
            command = prefix + ['prepare-browser-bundle', '--source-commit', source,
                                'export', '--path', str(partial / 'bundle')]
            try:
                run(command)
                finished = now()
                validation = validate(partial / 'bundle', source, prefix, run)
                receipt = {'version': 1, 'source_commit': source, 'platform': 'linux/amd64',
                           'build_started_at': started, 'build_finished_at': finished,
                           'build_exit_code': 0, 'build_command': command,
                           'manifest_sha256': validation['manifestSha256'],
                           'validation': validation}
                (partial / 'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
                receipt_hash = sha256(partial / 'build-receipt.json')
                (partial / 'COMPLETED').write_text(receipt_hash + '\n')
                if entry.is_symlink():
                    entry.unlink()
                elif entry.exists():
                    shutil.rmtree(entry)
                partial.replace(entry)
            finally:
                if partial.exists():
                    shutil.rmtree(partial)
        materialize(entry / 'bundle', output, source, prefix, run)
        return {'version': 1, 'status': status, 'source_commit': source,
                'original_build_receipt_sha256': receipt_hash, 'original_build': receipt,
                'validation': validation, 'cache_entry': str(entry), 'published_bundle': str(output),
                'checked_at': now()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--cache-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--cache-namespace', required=True)
    parser.add_argument('--max-build-jobs', type=int, default=4)
    parser.add_argument('--build-jobs', type=int, default=0)
    args = parser.parse_args()
    if not 0 <= args.build_jobs <= 128:
        parser.error('--build-jobs must be between 0 and 128')
    prefix = ['dagger', 'call', '--cache-namespace', args.cache_namespace,
              '--max-build-jobs', str(args.max_build_jobs)]
    if args.build_jobs:
        prefix += ['--build-jobs', str(args.build_jobs)]
    receipt = ensure_bundle(args.source_commit, args.cache_root, args.output, prefix)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
