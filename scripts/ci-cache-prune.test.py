#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('prune', Path(__file__).with_name('ci-cache-prune.py'))
prune = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune)


class CacheMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.current = 'c' * 40
    def tearDown(self):
        self.temp.cleanup()
    def archive(self, source, day):
        manifest = hashlib.sha256(source.encode()).hexdigest()
        path = self.root / (source + '-' + manifest)
        (path / 'bundle').mkdir(parents=True)
        for name in (*prune.PAYLOADS, 'manifest.json', 'test-inventory.json'):
            (path / 'bundle' / name).write_text(name)
        for name in prune.METADATA:
            (path / name).write_text('{}')
        receipt = {'manifest_sha256': manifest, 'build_finished_at': '2026-11-' + str(day) + 'T00:00:00+00:00'}
        return path, receipt
    def test_only_oldest_verified_payloads_removed_with_all_receipts_preserved(self):
        old, a = self.archive('a' * 40, 20)
        new, b = self.archive('b' * 40, 21)
        partial = self.root / '.unfinished.partial'; partial.mkdir()
        unrelated = self.root / 'reports'; unrelated.mkdir(); (unrelated / 'pass.json').write_text('passed')
        def validate(path, source, check):return (a if path == old else b), {}
        def space(path):return SimpleNamespace(free=100 if (old / 'bundle/client.oci.tar').exists() else 1000)
        with mock.patch.object(prune.shutil, 'disk_usage', side_effect=space):
            result = prune.prune_cache(self.root, self.current, 800, validate)
        self.assertEqual(result['status'], 'space-reclaimed')
        self.assertFalse(old.exists())
        hidden = self.root / ('.evicted-' + old.name)
        self.assertTrue(all((hidden / name).exists() for name in prune.METADATA))
        self.assertTrue((hidden / 'bundle/manifest.json').exists())
        self.assertTrue((hidden / 'bundle/test-inventory.json').exists())
        self.assertTrue((new / 'bundle/client.oci.tar').exists())
        self.assertTrue((unrelated / 'pass.json').exists())
        self.assertTrue(partial.is_dir())
    def test_current_and_newest_builds_never_deleted_even_when_space_is_insufficient(self):
        current, a = self.archive(self.current, 20)
        newest, b = self.archive('b' * 40, 21)
        with mock.patch.object(prune.shutil, 'disk_usage', return_value=SimpleNamespace(free=1)):
            with self.assertRaises(OSError):
                prune.prune_cache(self.root, self.current, 800, lambda p,s,c: ((a if p == current else b), {}))
        self.assertTrue((current / 'bundle/client.oci.tar').exists())
        self.assertTrue((newest / 'bundle/client.oci.tar').exists())
    def test_linked_corrupt_and_unknown_entries_are_never_evicted(self):
        old, a = self.archive('a' * 40, 20)
        foreign = self.root / 'foreign'; foreign.write_text('preserve')
        (old / 'bundle/client.oci.tar').unlink(); (old / 'bundle/client.oci.tar').symlink_to(foreign)
        with mock.patch.object(prune.shutil, 'disk_usage', return_value=SimpleNamespace(free=1)):
            with self.assertRaises(OSError):
                prune.prune_cache(self.root, self.current, 800, lambda *a: self.fail('must reject link before hashing'))
        self.assertEqual(foreign.read_text(), 'preserve')
        self.assertTrue(old.is_dir())
    def test_no_maintenance_when_space_already_sufficient_and_deadline_is_checked(self):
        with mock.patch.object(prune.shutil, 'disk_usage', return_value=SimpleNamespace(free=1000)):
            result = prune.prune_cache(self.root, self.current, 800, lambda *a: self.fail('unneeded hash'))
        self.assertEqual(result['evictions'], [])
        with self.assertRaises(TimeoutError):
            prune.prune_cache(self.root, self.current, 800, lambda *a: None, mock.Mock(side_effect=TimeoutError('deadline')))


if __name__ == '__main__':
    unittest.main()
