#!/usr/bin/env python3
"""Host-cache lifecycle tests using tiny artifacts and a recording build fixture."""
import concurrent.futures
import errno
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('browser_build', Path(__file__).with_name('ci-browser-build.py'))
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
SHA = 'a' * 40


class Fixture:
    def __init__(self):
        self.builds = 0
        self.calls = []
        self.pin = 'fixture-tool-1'
        self.fail = False
        self.lock = threading.Lock()

    def __call__(self, args, capture=False):
        def value(name):
            return args[args.index(name) + 1]
        with self.lock:
            self.calls.append(list(args))
        if 'prepare-browser-bundle' in args:
            with self.lock:
                self.builds += 1
            if self.fail:
                raise subprocess.CalledProcessError(1, args)
            time.sleep(.025)
            path = Path(value('--path'))
            path.mkdir()
            for name in helper.FILES[1:]:
                (path / name).write_text('small fixture payload ' + name)
            manifest = {'sourceCommit': value('--source-commit'), 'platform': 'linux/amd64',
                        'tool': self.pin, 'files': {name:helper.sha256(path / name) for name in helper.FILES[1:]}}
            (path / 'manifest.json').write_text(json.dumps(manifest))
            return
        self.assert_validate(args)
        path = Path(value('--bundle'))
        manifest = json.loads((path / 'manifest.json').read_text())
        if (manifest['sourceCommit'] != value('--expected-commit') or manifest['tool'] != self.pin
                or helper.sha256(path / 'manifest.json') != value('--manifest-sha256')
                or any(helper.sha256(path / name) != expected for name,expected in manifest['files'].items())):
            raise subprocess.CalledProcessError(1, args)
        return json.dumps({**manifest, 'manifestSha256':value('--manifest-sha256'),
                           'kind':'browser-bundle-validation', 'validatedAt':'fixture-now'})

    def assert_validate(self, args):
        if 'validate-browser-bundle' not in args:
            raise AssertionError('unexpected non-validation/non-build invocation: ' + repr(args))


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cache, self.output = self.root / 'cache', self.root / 'share/bundle'
        self.fixture = Fixture()

    def tearDown(self):
        self.temp.cleanup()

    def run_helper(self, source=SHA):
        return helper.ensure_bundle(source, self.cache, self.output, ['fixture-dagger', 'call'], self.fixture)

    def test_valid_hit_never_builds_and_preserves_original_success_receipt(self):
        first = self.run_helper()
        receipt = Path(first['cache_entry']) / 'build-receipt.json'
        original = receipt.read_bytes()
        second = self.run_helper()
        self.assertEqual((first['status'], second['status']), ('built', 'cached'))
        self.assertEqual(self.fixture.builds, 1)
        self.assertEqual(second['original_build_receipt_sha256'], first['original_build_receipt_sha256'])
        self.assertEqual(receipt.read_bytes(), original)
        self.assertEqual(second['original_build'], first['original_build'])
        self.assertTrue(all((self.output / name).is_file() and not (self.output / name).is_symlink()
                            for name in helper.FILES))

    def test_wrong_source_corrupt_payload_and_changed_tool_are_not_hits(self):
        first = self.run_helper()
        (Path(first['cache_entry']) / 'bundle/client.oci.tar').write_text('corruption')
        self.assertEqual(self.run_helper()['status'], 'built')
        self.fixture.pin = 'fixture-tool-2'
        self.assertEqual(self.run_helper()['status'], 'built')
        self.assertEqual(self.run_helper('b' * 40)['status'], 'built')
        self.assertEqual(self.fixture.builds, 4)

    def test_missing_marker_and_partial_entry_are_never_success(self):
        first = self.run_helper()
        (Path(first['cache_entry']) / 'COMPLETED').unlink()
        self.assertEqual(self.run_helper()['status'], 'built')
        (self.cache / ('.' + SHA + '.abandoned.partial')).mkdir()
        self.assertEqual(self.run_helper('c' * 40)['status'], 'built')
        self.assertEqual(self.fixture.builds, 3)

    def test_failed_build_is_not_published_as_complete(self):
        self.fixture.fail = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_helper()
        self.assertFalse(list(self.cache.glob('*/COMPLETED')))
        self.assertFalse(self.output.exists())
        self.fixture.fail = False
        self.assertEqual(self.run_helper()['status'], 'built')
        self.assertEqual(self.fixture.builds, 2)

    def test_receipt_relabeling_is_rejected_even_with_recomputed_marker(self):
        first = self.run_helper()
        entry = Path(first['cache_entry'])
        receipt = first['original_build']
        receipt['source_commit'] = 'b' * 40
        (entry / 'build-receipt.json').write_text(json.dumps(receipt))
        (entry / 'COMPLETED').write_text(helper.sha256(entry / 'build-receipt.json'))
        self.assertEqual(self.run_helper()['status'], 'built')
        self.assertEqual(self.fixture.builds, 2)

    def test_concurrent_requests_have_one_writer_and_one_build(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            requests = [pool.submit(self.run_helper) for _ in range(2)]
            results = [request.result() for request in requests]
        self.assertEqual(sorted(result['status'] for result in results), ['built', 'cached'])
        self.assertEqual(self.fixture.builds, 1)

    def test_overlapping_relative_and_symlink_alias_paths_are_rejected(self):
        self.cache.mkdir()
        alias = self.root / 'alias'
        alias.symlink_to(self.cache, target_is_directory=True)
        cases = [(self.cache, self.cache), (self.cache, self.root),
                 (self.cache, self.cache / 'view'), (self.cache, alias),
                 (Path('relative'), self.output), (self.cache, Path('relative'))]
        for cache, output in cases:
            with self.subTest(cache=cache, output=output), self.assertRaises(ValueError):
                helper.ensure_bundle(SHA, cache, output, ['fixture'], self.fixture)
        self.assertEqual(self.fixture.builds, 0)

    def test_unrecognized_output_is_preserved(self):
        self.output.mkdir(parents=True)
        foreign = self.output / 'unrelated-user-file'
        foreign.write_text('preserve this')
        with self.assertRaisesRegex(ValueError, 'unrecognized files'):
            self.run_helper()
        self.assertEqual(foreign.read_text(), 'preserve this')

    def test_cache_entry_symlink_cannot_be_a_hit(self):
        first = self.run_helper()
        entry = Path(first['cache_entry'])
        original = entry.with_name('original-entry')
        entry.rename(original)
        entry.symlink_to(original, target_is_directory=True)
        self.assertEqual(self.run_helper()['status'], 'built')
        self.assertFalse(entry.is_symlink())
        self.assertTrue((original / 'COMPLETED').is_file())

    def test_cross_filesystem_publication_copies_regular_files(self):
        with mock.patch.object(helper.os, 'link', side_effect=OSError(errno.EXDEV, 'different filesystem')):
            result = self.run_helper()
        self.assertEqual(result['status'], 'built')
        for name in helper.FILES:
            self.assertEqual((self.output / name).read_bytes(), (Path(result['cache_entry']) / 'bundle' / name).read_bytes())
            self.assertFalse((self.output / name).is_symlink())


if __name__ == '__main__':
    unittest.main()
