#!/usr/bin/env python3
"""Exercise real report packing/extraction; provider and SCP effects are local."""
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('collection', Path(__file__).with_name('ci-fanout-cloud-launch.py'))
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.mount = self.root / 'retained'
        self.boot = self.root / 'boot'
        self.boot.mkdir()
        self.source = self.mount / 'runs' / 'fixture'
        self.source.mkdir(parents=True)
        self.remote_archives = []
        self.local = self.root / 'operator'
        self.local.mkdir()
        self.state = {'controller': {'ip': '127.0.0.1'}}
        self.client = object.__new__(launch.CloudLauncher)
        self.client.config = {'batch_key': 'fixture', 'source_commit': 'a' * 40}
        self.client.account = {}
        self.client.api = types.SimpleNamespace(identity=lambda account: None)
        self.client.root = self.local
        self.client.reconcile_controller = lambda: True
        self.client.read = lambda: self.state
        self.client.update = lambda update: update(self.state)
        self.client.now = lambda: dt.datetime.now(dt.timezone.utc)
        self.client.ssh = self.remote
        self.client.run = self.transfer

    def remote(self, command, timeout):
        for remote in set(re.findall(r'/tmp/atomic-ci-reports-[a-f0-9]{32}\.tgz', command)):
            local = self.root / Path(remote).name
            if command.startswith('python3'):
                self.remote_archives.append(local)
            command = command.replace(remote, str(local))
        return subprocess.check_output(['sh', '-c', command], text=True, timeout=timeout)

    def transfer(self, command, timeout):
        self.assertEqual(command[0], 'scp')
        shutil.copyfile(self.root / Path(command[-2].split(':', 1)[1]).name, command[-1])

    def collect(self, **kwargs):
        with mock.patch.object(launch, 'MOUNT', str(self.mount)), mock.patch.object(launch, 'ROOT', str(self.boot)):
            return self.client.collect(**kwargs)

    def test_full_collection_expands_safe_hardlinks_without_changing_source_bytes(self):
        first = self.source / 'test-results/trace.zip'
        first.parent.mkdir()
        first.write_bytes(b'owned trace payload' * 8192)
        second = self.source / 'playwright-report/data/trace.zip'
        second.parent.mkdir(parents=True)
        os.link(first, second)
        (self.source / 'result.json').write_text('{"status":"failed"}')
        result = self.collect()
        self.assertEqual(result['collection_scope'], 'full')
        with tarfile.open(self.local / 'reports.tgz') as archive:
            members = [member for member in archive if member.name.endswith('trace.zip')]
        self.assertEqual(len(members), 2)
        self.assertTrue(all(member.isfile() and not member.islnk() for member in members))
        for relative in ('test-results/trace.zip', 'playwright-report/data/trace.zip'):
            self.assertEqual((self.local / 'reports' / relative).read_bytes(), first.read_bytes())
        self.assertEqual(first.stat().st_ino, second.stat().st_ino)

    def test_metadata_only_keeps_raw_traces_on_server_and_records_scope(self):
        (self.source / 'result.json').write_text('{"status":"failed"}')
        (self.source / 'command.log').write_text('actual failure')
        trace = self.source / 'trace.zip'
        trace.write_bytes(b'raw trace remains on DO')
        (self.source / 'operator-key').write_text('forbidden fixture')
        outside = self.root / 'outside.log'
        outside.write_text('outside sentinel')
        (self.source / 'linked.log').symlink_to(outside)
        result = self.collect(metadata_only=True)
        self.assertEqual(result['collection_scope'], 'metadata-only')
        self.assertEqual(self.state['reports_collection_scope'], 'metadata-only')
        self.assertEqual(trace.read_bytes(), b'raw trace remains on DO')
        reports = self.local / 'reports'
        self.assertTrue((reports / 'result.json').exists())
        self.assertTrue((reports / 'command.log').exists())
        self.assertFalse((reports / 'trace.zip').exists())
        self.assertFalse((reports / 'operator-key').exists())
        self.assertFalse((reports / 'linked.log').exists())
        scope = json.loads((reports / 'COLLECTION-SCOPE.json').read_text())
        self.assertEqual(scope['source_commit'], 'a' * 40)
        self.assertEqual(scope['omitted_files'], 1)
        self.assertEqual(scope['retained_raw_reports'], str(self.source))

    def test_reserved_scope_file_cannot_impersonate_collector_receipt(self):
        (self.source / 'COLLECTION-SCOPE.json').write_text('{}')
        with self.assertRaises(subprocess.CalledProcessError):
            self.collect(metadata_only=True)
        self.assertNotIn('reports_collected_at', self.state)

    def test_collections_use_independent_archives_and_do_not_mix_extracted_scopes(self):
        (self.source / 'result.json').write_text('{}')
        (self.source / 'trace.zip').write_bytes(b'raw trace')
        self.collect()
        self.assertTrue((self.local / 'reports/trace.zip').exists())
        self.collect(metadata_only=True)
        self.assertEqual(len(set(self.remote_archives)), 2)
        self.assertTrue(all(not path.exists() for path in self.remote_archives))
        self.assertFalse((self.local / 'reports/trace.zip').exists())
        self.assertEqual(len(list(self.local.glob('reports-previous-*/trace.zip'))), 1)

    def test_swapped_metadata_archive_cannot_be_labeled_full(self):
        (self.source / 'result.json').write_text('{}')
        original = self.client.ssh
        def swap(command, timeout):
            if command.startswith('python3'):
                command = command.replace("'scope':'metadata-only' if False else 'full'", "'scope':'metadata-only'")
            return original(command, timeout)
        self.client.ssh = swap
        with self.assertRaisesRegex(ValueError, 'scope or source'):
            self.collect()
        self.assertNotIn('reports_collected_at', self.state)
        self.assertFalse((self.local / 'reports').exists())

    def test_streaming_retrieval_never_loads_the_result_archive_into_one_bytes_object(self):
        archive_source = self.root / 'source.tgz'
        payload = self.root / 'result.json'
        payload.write_text('{"status":"failed"}')
        with tarfile.open(archive_source, 'w:gz') as archive:
            archive.add(payload, arcname='results/result.json')
        expected = hashlib.sha256(archive_source.read_bytes()).hexdigest()
        node = self.local / 'node-001'
        node.mkdir()
        updates = {}
        client = types.SimpleNamespace(root=self.local, config={'sample_resources': False},
            read=lambda: {'nodes': {'node-001': {}}}, ssh=lambda *args, **kwargs: '',
            scp=lambda _, sources, destination, **kwargs: shutil.copyfile(archive_source, destination),
            node_update=lambda _, **kwargs: updates.update(kwargs))
        read_bytes = Path.read_bytes
        def guarded(path):
            if path == node / 'results.tgz':
                raise AssertionError('large transfer archive must be hashed incrementally')
            return read_bytes(path)
        with mock.patch.object(Path, 'read_bytes', guarded):
            launch.BASE.Controller.retrieve(client, 'node-001')
        self.assertEqual(updates['artifact_sha256'], expected)
        self.assertEqual(json.loads((node / 'results/result.json').read_text()), {'status': 'failed'})


if __name__ == '__main__':
    unittest.main()
