#!/usr/bin/env python3
"""Pinned private test sources on ephemeral disks, never in public reports.

Only Git object contents enter a capsule. Environment files, Git metadata and
key files are excluded. Verification constructs a small receipt, without source
names or contents. No credentials or production environment are loaded here.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import uuid

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_FILES = 20000
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
DESCRIPTOR_KEYS = {'source_commit', 'archive_path', 'archive_sha256', 'manifest_path', 'manifest_sha256'}


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(data)
    return digest.hexdigest()


def _safe_path(name):
    if not isinstance(name, str) or not name or '\\' in name or '\x00' in name:
        raise ValueError('invalid private source path')
    path = PurePosixPath(name)
    if not path.parts or path.is_absolute() or str(path) != name or any(p in ('..', '.') for p in path.parts):
        raise ValueError('unsafe private source path')
    return path


def excluded_path(name):
    path = _safe_path(name)
    return path.parts[0] in ('.pnpm-store', 'node_modules', 'target', '.dart_tool', '.cache') or any(part == '.git' or part.startswith('.env') or part.endswith('.env')
               or part.lower().endswith(('.pem', '.key', '.p12', '.pfx'))
               or part in ('id_rsa', 'id_ed25519', '.netrc', '.npmrc', '.pypirc')
               for part in path.parts)


def _regular(path, maximum):
    path = Path(path)
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('private input must use absolute paths without symlinks')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
        raise ValueError('private input is not a bounded regular file')
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('private input files must have owner-only permissions')
    return path


def validate_descriptor(descriptor):
    if not isinstance(descriptor, dict) or set(descriptor) != DESCRIPTOR_KEYS:
        raise ValueError('private input descriptor has an unsupported schema')
    if not isinstance(descriptor['source_commit'], str) or not re.fullmatch(r'[a-f0-9]{40}', descriptor['source_commit']):
        raise ValueError('private source commit must be pinned')
    for name in ('archive_sha256', 'manifest_sha256'):
        if not isinstance(descriptor[name], str) or not re.fullmatch(r'[a-f0-9]{64}', descriptor[name]):
            raise ValueError('private input hashes must be pinned')
    for name in ('archive_path', 'manifest_path'):
        if not isinstance(descriptor[name], str) or not Path(descriptor[name]).is_absolute():
            raise ValueError('private input paths must be absolute')
    if descriptor['archive_path'] == descriptor['manifest_path']:
        raise ValueError('private archive and manifest must be distinct')
    return dict(descriptor)


def remote_descriptor(descriptor, root):
    result = validate_descriptor(descriptor)
    parent = PurePosixPath(root) / 'private-input'
    if not parent.is_absolute() or '..' in parent.parts:
        raise ValueError('private controller root must be absolute')
    result.update(archive_path=str(parent / 'source.tar'), manifest_path=str(parent / 'manifest.json'))
    return result


def _manifest(descriptor):
    path = _regular(descriptor['manifest_path'], MAX_MANIFEST_BYTES)
    if sha256(path) != descriptor['manifest_sha256']:
        raise ValueError('private manifest checksum differs')
    manifest = json.loads(path.read_text())
    if (not isinstance(manifest, dict) or manifest.get('version') != 1
            or manifest.get('repository') != 'ontola/atomic-saas'
            or manifest.get('source_commit') != descriptor['source_commit']):
        raise ValueError('private manifest provenance differs')
    files = manifest.get('files')
    if not isinstance(files, list) or not 0 < len(files) <= MAX_FILES:
        raise ValueError('private manifest file inventory is missing or oversized')
    expected = {}
    for item in files:
        if not isinstance(item, dict) or set(item) != {'path', 'sha256', 'size', 'executable'}:
            raise ValueError('private manifest file schema differs')
        name = item['path']
        if excluded_path(name) or name in expected:
            raise ValueError('private manifest contains excluded or duplicate paths')
        if (type(item['size']) is not int or not 0 <= item['size'] <= MAX_FILE_BYTES
                or type(item['executable']) is not bool
                or not isinstance(item['sha256'], str)
                or not re.fullmatch(r'[a-f0-9]{64}', item['sha256'])):
            raise ValueError('invalid private manifest file metadata')
        expected[name] = item
    if sum(item['size'] for item in files) > MAX_TOTAL_BYTES:
        raise ValueError('private source exceeds its extraction budget')
    for required in ('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'managed-node/Cargo.toml', 'portal/package-lock.json'):
        if required not in expected:
            raise ValueError('private source lacks a required build input')
    return expected


def verify_capsule(descriptor):
    descriptor = validate_descriptor(descriptor)
    archive = _regular(descriptor['archive_path'], MAX_TOTAL_BYTES + MAX_FILES * 2048)
    expected = _manifest(descriptor)
    if sha256(archive) != descriptor['archive_sha256']:
        raise ValueError('private archive checksum differs')
    seen = set()
    with tarfile.open(archive, 'r:') as source:
        for member in source:
            name = str(_safe_path(member.name))
            if excluded_path(name) or not member.isfile() or name in seen or name not in expected:
                raise ValueError('private archive inventory differs or contains a link/special file')
            item = expected[name]
            if member.size != item['size'] or bool(member.mode & 0o111) != item['executable']:
                raise ValueError('private archive file metadata differs')
            with source.extractfile(member) as stream:
                actual = hashlib.sha256(stream.read(MAX_FILE_BYTES + 1)).hexdigest()
            if actual != item['sha256']:
                raise ValueError('private archive file checksum differs')
            seen.add(name)
    if seen != set(expected):
        raise ValueError('private archive is missing manifest files')
    return {'version': 1, 'status': 'verified', 'repository': 'ontola/atomic-saas',
            'source_commit': descriptor['source_commit'], 'archive_sha256': descriptor['archive_sha256'],
            'manifest_sha256': descriptor['manifest_sha256'], 'file_count': len(expected),
            'source_bytes': sum(item['size'] for item in expected.values())}


def extract_capsule(descriptor, destination):
    receipt = verify_capsule(descriptor)
    destination = Path(destination)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink():
        raise ValueError('private extraction requires a new absolute destination')
    if any(p.is_symlink() for p in destination.parents) or not destination.parent.is_dir():
        raise ValueError('private extraction parent is absent or traverses a symlink')
    partial = Path(tempfile.mkdtemp(prefix='.private-input-', dir=destination.parent))
    expected = _manifest(descriptor)
    try:
        with tarfile.open(descriptor['archive_path'], 'r:') as source:
            seen = set()
            for member in source:
                name = str(_safe_path(member.name))
                if not member.isfile() or name in seen or name not in expected:
                    raise ValueError('private archive changed after verification')
                target = partial.joinpath(*PurePosixPath(name).parts)
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                item = expected[name]
                if member.size != item['size']:
                    raise ValueError('private file changed after verification')
                with source.extractfile(member) as src, target.open('xb') as out:
                    shutil.copyfileobj(src, out)
                target.chmod(0o700 if item['executable'] else 0o600)
                if sha256(target) != item['sha256']:
                    raise ValueError('private extracted file checksum differs')
                seen.add(name)
        if seen != set(expected) or sha256(descriptor['archive_path']) != descriptor['archive_sha256']:
            raise ValueError('private capsule changed during extraction')
        partial.rename(destination)
    finally:
        if partial.exists():
            shutil.rmtree(partial)
    return receipt


def create_capsule(repo, source_commit, output):
    repo, output = Path(repo), Path(output)
    def git(*args, **kwargs):
        return subprocess.run(['git', '-C', str(repo), *args], check=True, timeout=120, **kwargs)
    if (git('rev-parse', 'HEAD', capture_output=True).stdout.decode().strip() != source_commit
            or git('status', '--porcelain=v1', '--untracked-files=no', capture_output=True).stdout.strip()):
        raise ValueError('private checkout is not the exact clean source pin')
    if not output.is_absolute() or output.exists() or any(p.is_symlink() for p in output.parents):
        raise ValueError('private capsule output must be a new absolute directory')
    output.mkdir(mode=0o700, parents=True)
    archive, manifest_path = output / 'source.tar', output / 'manifest.json'
    entries, excluded, total = [], [], 0
    try:
        with tempfile.TemporaryFile() as raw:
            git('archive', '--format=tar', source_commit, stdout=raw, stderr=subprocess.PIPE)
            raw.seek(0)
            with tarfile.open(fileobj=raw, mode='r:') as original, tarfile.open(archive, 'w:', format=tarfile.PAX_FORMAT) as target:
                for member in original:
                    if member.isdir():
                        continue
                    if excluded_path(member.name):
                        excluded.append(member.name)
                        continue
                    if not member.isfile() or not 0 <= member.size <= MAX_FILE_BYTES:
                        raise ValueError('private Git source contains unsupported special or oversized files')
                    total += member.size
                    if total > MAX_TOTAL_BYTES or len(entries) >= MAX_FILES:
                        raise ValueError('private Git source exceeds its capsule budget')
                    with original.extractfile(member) as stream:
                        data = stream.read(MAX_FILE_BYTES + 1)
                    import io
                    record = tarfile.TarInfo(member.name)
                    executable = bool(member.mode & 0o111)
                    record.size, record.mode = len(data), 0o700 if executable else 0o600
                    target.addfile(record, io.BytesIO(data))
                    entries.append({'path': member.name, 'sha256': hashlib.sha256(data).hexdigest(),
                                    'size': len(data), 'executable': executable})
        archive.chmod(0o600)
        manifest = {'version': 1, 'repository': 'ontola/atomic-saas', 'source_commit': source_commit,
                    'files': sorted(entries, key=lambda item: item['path']), 'excluded_paths': sorted(excluded)}
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n'); manifest_path.chmod(0o600)
        descriptor = {'source_commit': source_commit, 'archive_path': str(archive), 'archive_sha256': sha256(archive),
                      'manifest_path': str(manifest_path), 'manifest_sha256': sha256(manifest_path)}
        verify_capsule(descriptor)
        return descriptor
    except BaseException:
        shutil.rmtree(output)
        raise


def _write_json(path, value):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    with temporary.open('x') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2); stream.write('\n')
    temporary.replace(path)


def _ack(config, receipt):
    return dict(receipt, batch_key=config['batch_key'], public_source_commit=config['source_commit'])


def wait_controller_input(config, guard_deadline):
    descriptor = config['fanout_config'].get('private_input')
    if descriptor is None:
        return None
    if descriptor != remote_descriptor(descriptor, config['root']):
        raise ValueError('private input must remain on the controller boot disk')
    ready = Path(config['root']) / 'private-input' / 'READY.json'
    while True:
        guard_deadline()
        if all(Path(descriptor[field]).is_file() for field in ('archive_path', 'manifest_path')):
            receipt = _ack(config, verify_capsule(descriptor))
            _write_json(ready, receipt)
            return receipt
        time.sleep(1)


def stage_controller_input(launcher):
    descriptor = launcher.config.get('private_input')
    if descriptor is None:
        return None
    receipt = verify_capsule(descriptor)
    remote = launcher.remote_config()
    target = remote_descriptor(descriptor, remote['root'])
    parent = str(PurePosixPath(target['archive_path']).parent)
    setup_deadline = launcher.now() + dt.timedelta(minutes=10)
    def remaining():
        end = dt.datetime.fromisoformat(launcher.read()['deadline'].replace('Z', '+00:00'))
        seconds = (min(end, setup_deadline) - launcher.now()).total_seconds()
        if seconds <= 0:
            raise TimeoutError('private input upload reached the campaign deadline')
        return seconds
    while True:
        remaining()
        launcher.api.identity(launcher.account)
        present = launcher.reconcile_controller()
        if present and launcher.read()['controller'].get('ip'):
            try:
                launcher.ssh('test -d ' + shlex.quote(remote['root']) + ' && test ! -L ' + shlex.quote(parent)
                             + ' && umask 077 && mkdir -p ' + shlex.quote(parent), timeout=min(20, remaining()))
                break
            except (RuntimeError, subprocess.SubprocessError):
                pass
        time.sleep(min(2, remaining()))
    node = launcher.read()['controller']
    options = ['-i', str(launcher.root / 'controller-key'), '-o', 'BatchMode=yes',
               '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ConnectTimeout=8',
               '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(launcher.root / 'controller.known-hosts')]
    for key in ('archive_path', 'manifest_path'):
        partial = target[key] + '.upload'
        launcher.run(['scp', *options, descriptor[key], 'root@' + node['ip'] + ':' + partial],
                     timeout=min(180, remaining()), text=True)
        launcher.ssh('chmod 600 ' + shlex.quote(partial) + ' && mv -- ' + shlex.quote(partial) + ' ' + shlex.quote(target[key]),
                     timeout=min(20, remaining()))
    ready = parent + '/READY.json'
    expected = _ack(remote, receipt)
    while True:
        remaining()
        raw = launcher.ssh('if test -f ' + shlex.quote(ready) + '; then cat ' + shlex.quote(ready) + '; fi',
                           timeout=min(20, remaining()))
        if raw.strip():
            if json.loads(raw) != expected:
                raise ValueError('private input acknowledgement differs from this campaign')
            launcher.update(lambda state: state.update(private_input_receipt=expected))
            return expected
        time.sleep(min(1, remaining()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('create', 'verify', 'extract'))
    parser.add_argument('--repo', type=Path)
    parser.add_argument('--source-commit')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--descriptor', type=Path)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    if args.command == 'create':
        result = create_capsule(args.repo, args.source_commit, args.output)
    else:
        descriptor = json.loads(args.descriptor.read_text())
        result = extract_capsule(descriptor, args.destination) if args.command == 'extract' else verify_capsule(descriptor)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
