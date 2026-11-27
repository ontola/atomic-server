#!/usr/bin/env python3
"""Free retained build-cache space before workers start; preserve all receipts.

Only complete, validated public build archives are candidates. The newest and
current-source builds, partial exports and unknown files remain untouched.
Eviction hides the old entry, removes three regenerable payloads, and retains
its manifest, test inventory, original build receipt and provenance.
"""
from __future__ import annotations
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time

NAME = re.compile(r'([a-f0-9]{40})-([a-f0-9]{64})')
PAYLOADS = ('atomic-server-binary', 'client.oci.tar', 'checks.oci.tar')
METADATA = ('build-receipt.json', 'COMPLETED', 'archive-provenance.json')


def _identity(path, directory=False):
    info = path.lstat()
    if ((not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode))
            or info.st_uid != os.geteuid() or not directory and info.st_nlink != 1):
        raise ValueError('cache entry is not an owned regular file/directory')
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def prune_cache(root, source_commit, minimum_free_bytes, validate_archive, check=lambda: None):
    root = Path(root)
    if (not root.is_absolute() or any(p.is_symlink() for p in (root, *root.parents))
            or not re.fullmatch(r'[a-f0-9]{40}', source_commit)
            or type(minimum_free_bytes) is not int or not 0 < minimum_free_bytes <= 8 * 1024**3):
        raise ValueError('invalid bounded cache maintenance request')
    root.mkdir(mode=0o700, exist_ok=True)
    root_device = _identity(root, directory=True)[0]
    lock_path = root / '.storage-maintenance.lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        _identity(lock_path)
        started = time.monotonic()
        while True:
            check()
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() - started >= 30:
                    raise TimeoutError('cache maintenance lock was not available')
                time.sleep(.1)
        before = shutil.disk_usage(root).free
        result = {'version': 1, 'status': 'enough-space', 'source_commit': source_commit,
                  'minimum_free_bytes': minimum_free_bytes, 'free_before_bytes': before,
                  'free_after_bytes': before, 'evictions': []}
        if before >= minimum_free_bytes:
            return result
        candidates = []
        for path in root.iterdir():
            check()
            match = NAME.fullmatch(path.name)
            if not match:
                continue
            try:
                directory = _identity(path, directory=True)
                bundle = _identity(path / 'bundle', directory=True)
                if directory[0] != root_device or bundle[0] != root_device:
                    raise ValueError('cache entry is on a foreign mount')
                for name in METADATA:
                    if _identity(path / name)[0] != root_device:
                        raise ValueError('cache metadata is on a foreign mount')
                identities = {name: _identity(path / 'bundle' / name) for name in
                              (*PAYLOADS, 'manifest.json', 'test-inventory.json')}
                if any(identity[0] != root_device for identity in identities.values()):
                    raise ValueError('cache payload is on a foreign mount')
                receipt, manifest = validate_archive(path, match[1], check)
                if match[2] != receipt['manifest_sha256']:
                    raise ValueError('archive name and successful receipt differ')
                moment = dt.datetime.fromisoformat(receipt['build_finished_at'].replace('Z', '+00:00'))
                if moment.utcoffset() is None:
                    raise ValueError('build completion time has no timezone')
                if (_identity(path, directory=True) != directory
                        or _identity(path / 'bundle', directory=True) != bundle
                        or any(_identity(path / 'bundle' / name) != identity for name, identity in identities.items())):
                    raise ValueError('archive changed during verification')
                candidates.append({'path': path, 'source': match[1], 'at': moment,
                                   'directory': directory, 'bundle': bundle, 'identities': identities})
            except TimeoutError:
                raise
            except (OSError, ValueError, KeyError, TypeError):
                # Unknown, linked, incomplete or corrupt files are never deleted.
                continue
        if not candidates:
            raise OSError('retained cache lacks enough space and no safe disposable build exists')
        newest = max(candidates, key=lambda item: (item['at'], item['path'].name))['path']
        result['protected_newest_archive'] = newest.name
        for item in sorted(candidates, key=lambda item: (item['at'], item['path'].name)):
            check()
            path = item['path']
            if path == newest or item['source'] == source_commit:
                continue
            if (_identity(path, directory=True) != item['directory']
                    or _identity(path / 'bundle', directory=True) != item['bundle']):
                raise ValueError('cache changed before eviction')
            hidden = root / ('.evicted-' + path.name)
            if hidden.exists() or hidden.is_symlink():
                raise ValueError('an earlier cache eviction requires reconciliation')
            path.rename(hidden)
            event = {'archive': path.name, 'retained_metadata_directory': hidden.name,
                     'payload_files': list(PAYLOADS), 'payload_bytes': sum(item['identities'][name][2] for name in PAYLOADS),
                     'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'payload_removed': False}
            marker = hidden / 'EVICTED.json'
            marker.write_text(json.dumps(event, indent=2) + '\n'); marker.chmod(0o600)
            for name in PAYLOADS:
                check()
                if (_identity(hidden, directory=True)[:2] != item['directory'][:2]
                        or _identity(hidden / 'bundle', directory=True)[:2] != item['bundle'][:2]):
                    raise ValueError('cache payload directory changed before eviction')
                target = hidden / 'bundle' / name
                if _identity(target) != item['identities'][name]:
                    raise ValueError('cache payload changed before eviction')
                target.unlink()
            event['payload_removed'] = True
            marker.write_text(json.dumps(event, indent=2) + '\n')
            result['evictions'].append(event)
            result['free_after_bytes'] = shutil.disk_usage(root).free
            if result['free_after_bytes'] >= minimum_free_bytes:
                result['status'] = 'space-reclaimed'
                return result
        raise OSError('safe cache eviction cannot provide the requested reserve; protected builds remain')
