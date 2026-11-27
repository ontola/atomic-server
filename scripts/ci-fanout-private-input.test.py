#!/usr/bin/env python3
"""Private source provenance and extraction boundaries; no provider calls."""
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location('private_input', Path(__file__).with_name('ci-fanout-private-input.py'))
private = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(private)


class PrivateInputTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        self.files = {'Cargo.toml': '[workspace]\n', 'Cargo.lock': '# locked\n',
                      'rust-toolchain.toml': '[toolchain]\nchannel="1.98.1"\n',
                      'managed-node/Cargo.toml': '[package]\nname="fixture"\n',
                      'portal/package-lock.json': '{}\n', 'src/main.rs': 'fn main() {}\n',
                      'portal/src/secretSignIn.ts': 'export const secretSignIn = true;\n',
                      'development.env': 'DO_NOT_EXPORT_THIS_SENTINEL=production\n',
                      'portal/.env.production': 'DO_NOT_EXPORT_THIS_SENTINEL=portal\n',
                      'template.env': 'DO_NOT_EXPORT_THIS_SENTINEL=template\n',
                      'private.key': 'DO_NOT_EXPORT_THIS_SENTINEL=key\n',
                      'scripts/test.sh': '#!/bin/sh\nexit 0\n'}
        for name, text in self.files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        (self.repo / 'scripts/test.sh').chmod(0o700)
        cache = self.repo / '.pnpm-store/v11/projects'
        cache.mkdir(parents=True)
        (cache / 'machine-specific-link').symlink_to('/Users/foreign/private-checkout')
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')
        self.pin = self.git('rev-parse', 'HEAD').strip()
        self.descriptor = private.create_capsule(self.repo, self.pin, self.root / 'capsule')

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True)

    def manifest(self):
        return json.loads(Path(self.descriptor['manifest_path']).read_text())

    def replace_manifest(self, manifest):
        path = Path(self.descriptor['manifest_path'])
        path.write_text(json.dumps(manifest))
        self.descriptor['manifest_sha256'] = private.sha256(path)

    def test_git_pin_excludes_environment_and_key_contents_without_losing_source(self):
        archive = Path(self.descriptor['archive_path'])
        self.assertNotIn(b'DO_NOT_EXPORT_THIS_SENTINEL', archive.read_bytes())
        self.assertNotIn(b'/Users/foreign', archive.read_bytes())
        self.assertNotIn('.git', {p['path'] for p in self.manifest()['files']})
        self.assertIn('portal/src/secretSignIn.ts', {p['path'] for p in self.manifest()['files']})
        receipt = private.verify_capsule(self.descriptor)
        self.assertEqual(receipt['source_commit'], self.pin)
        self.assertNotIn('files', receipt)
        self.assertNotIn('excluded_paths', receipt)
        self.assertEqual(os.stat(archive).st_mode & 0o777, 0o600)

    def test_extract_keeps_executable_and_private_permissions(self):
        destination = self.root / 'extracted'
        self.assertEqual(private.extract_capsule(self.descriptor, destination), private.verify_capsule(self.descriptor))
        self.assertEqual((destination / 'src/main.rs').read_text(), self.files['src/main.rs'])
        self.assertEqual((destination / 'scripts/test.sh').stat().st_mode & 0o777, 0o700)
        self.assertEqual((destination / 'src/main.rs').stat().st_mode & 0o777, 0o600)
        self.assertFalse((destination / 'development.env').exists())
        with self.assertRaises(ValueError):
            private.extract_capsule(self.descriptor, destination)

    def test_dirty_or_wrong_revision_cannot_claim_the_pin(self):
        with self.assertRaises(ValueError):
            private.create_capsule(self.repo, '0' * 40, self.root / 'wrong')
        (self.repo / 'src/main.rs').write_text('fn changed() {}')
        with self.assertRaises(ValueError):
            private.create_capsule(self.repo, self.pin, self.root / 'dirty')

    def test_descriptor_hash_and_permissions_tampering_are_rejected(self):
        for key in ('archive_sha256', 'manifest_sha256'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                private.verify_capsule(dict(self.descriptor, **{key: '0' * 64}))
        path = Path(self.descriptor['archive_path'])
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            private.verify_capsule(self.descriptor)

    def test_descriptor_schema_is_strict(self):
        for changed in ({'source_commit': 'main'}, {'archive_sha256': True},
                        {'archive_path': 'relative.tar'}, {'unexpected': 'value'}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                private.validate_descriptor(dict(self.descriptor, **changed))

    def test_manifest_missing_duplicated_or_excluded_inputs_fail(self):
        original = self.manifest()
        for files in (original['files'][1:], original['files'] + [original['files'][0]],
                      [dict(item, path='development.env') if i == 0 else item for i, item in enumerate(original['files'])]):
            self.replace_manifest(dict(original, files=files))
            with self.assertRaises(ValueError):
                private.verify_capsule(self.descriptor)

    def test_manifest_cannot_claim_another_source(self):
        self.replace_manifest(dict(self.manifest(), source_commit='1' * 40))
        with self.assertRaises(ValueError):
            private.verify_capsule(self.descriptor)

    def test_archive_traversal_links_duplicates_and_extra_files_rejected_before_write(self):
        for kind in ('traversal', 'symlink', 'hardlink', 'duplicate', 'extra'):
            with self.subTest(kind=kind):
                bad = self.root / (kind + '.tar')
                with tarfile.open(self.descriptor['archive_path'], 'r:') as src, tarfile.open(bad, 'w:') as out:
                    for member in src:
                        out.addfile(member, src.extractfile(member))
                    item = tarfile.TarInfo('../outside' if kind == 'traversal' else 'surprise')
                    if kind == 'symlink':
                        item.type, item.linkname = tarfile.SYMTYPE, '/tmp/foreign'
                    elif kind == 'hardlink':
                        item.type, item.linkname = tarfile.LNKTYPE, 'Cargo.toml'
                    elif kind == 'duplicate':
                        item.name = 'Cargo.toml'
                    out.addfile(item)
                bad.chmod(0o600)
                descriptor = dict(self.descriptor, archive_path=str(bad), archive_sha256=private.sha256(bad))
                dest = self.root / ('extract-' + kind)
                with self.assertRaises(ValueError):
                    private.extract_capsule(descriptor, dest)
                self.assertFalse(dest.exists())
                self.assertFalse((self.root / 'outside').exists())

    def test_symlinked_inputs_or_destination_parents_rejected(self):
        linked = self.root / 'linked.tar'
        linked.symlink_to(self.descriptor['archive_path'])
        with self.assertRaises(ValueError):
            private.verify_capsule(dict(self.descriptor, archive_path=str(linked)))
        linkdir = self.root / 'linked-dir'
        linkdir.symlink_to(self.root / 'capsule', target_is_directory=True)
        with self.assertRaises(ValueError):
            private.extract_capsule(self.descriptor, linkdir / 'extracted')

    def test_controller_ready_ack_binds_both_pins_and_does_not_expose_source_names(self):
        controller = self.root / 'controller'
        (controller / 'private-input').mkdir(parents=True)
        remote = private.remote_descriptor(self.descriptor, controller)
        for key in ('archive_path', 'manifest_path'):
            Path(remote[key]).write_bytes(Path(self.descriptor[key]).read_bytes())
            Path(remote[key]).chmod(0o600)
        config = {'root': str(controller), 'source_commit': 'a' * 40,
                  'batch_key': 'fixture', 'fanout_config': {'private_input': remote}}
        guards = []
        receipt = private.wait_controller_input(config, lambda: guards.append(True))
        self.assertTrue(guards)
        self.assertEqual(receipt['public_source_commit'], 'a' * 40)
        self.assertEqual(receipt['source_commit'], self.pin)
        self.assertEqual(json.loads((controller / 'private-input/READY.json').read_text()), receipt)
        self.assertNotIn('src/main.rs', json.dumps(receipt))

    def test_controller_wait_observes_deadline_and_rejects_retained_or_ambient_paths(self):
        config = {'root': str(self.root / 'controller'), 'fanout_config': {'private_input': self.descriptor}}
        with self.assertRaises(ValueError):
            private.wait_controller_input(config, lambda: None)
        config['fanout_config']['private_input'] = private.remote_descriptor(self.descriptor, config['root'])
        with self.assertRaises(TimeoutError):
            private.wait_controller_input(config, mock.Mock(side_effect=TimeoutError('deadline')))
        self.assertIsNone(private.wait_controller_input({'fanout_config': {}}, lambda: None))

    def launcher(self, bad_ack=False):
        now = dt.datetime.now(dt.timezone.utc)
        remote = {'root': '/opt/atomic-ci-cloud', 'source_commit': 'a' * 40, 'batch_key': 'fixture'}
        expected = private._ack(remote, private.verify_capsule(self.descriptor))
        if bad_ack:
            expected['public_source_commit'] = 'b' * 40
        state = {'deadline': (now + dt.timedelta(minutes=55)).isoformat(), 'controller': {'ip': '192.0.2.1'}}
        launcher = SimpleNamespace(config={'private_input': self.descriptor}, root=self.root,
            remote_config=lambda: remote, read=lambda: state, now=lambda: now,
            api=SimpleNamespace(identity=mock.Mock()), account={'expected_uuid': 'fixture'},
            reconcile_controller=mock.Mock(return_value=True), run=mock.Mock(),
            update=lambda change: change(state))
        launcher.ssh = mock.Mock(side_effect=lambda command, **kwargs: json.dumps(expected) if 'cat ' in command else '')
        return launcher, state

    def test_upload_pins_the_known_host_and_requires_source_bound_ack(self):
        launcher, state = self.launcher()
        result = private.stage_controller_input(launcher)
        self.assertEqual(result, state['private_input_receipt'])
        self.assertEqual(launcher.run.call_count, 2)
        for call in launcher.run.call_args_list:
            args = call.args[0]
            self.assertEqual(args[0], 'scp')
            self.assertIn('StrictHostKeyChecking=yes', args)
            self.assertIn('IdentityAgent=none', args)
            self.assertTrue(args[-1].startswith('root@192.0.2.1:/opt/atomic-ci-cloud/private-input/'))
            self.assertTrue(args[-1].endswith('.upload'))
        self.assertTrue(launcher.api.identity.called)

    def test_mismatched_ack_or_expired_deadline_never_reports_readiness(self):
        launcher, state = self.launcher(bad_ack=True)
        with self.assertRaises(ValueError):
            private.stage_controller_input(launcher)
        self.assertNotIn('private_input_receipt', state)
        launcher, state = self.launcher()
        state['deadline'] = (launcher.now() - dt.timedelta(seconds=1)).isoformat()
        with self.assertRaises(TimeoutError):
            private.stage_controller_input(launcher)
        launcher.run.assert_not_called()

    def test_producer_rejects_source_links_without_publishing_partial_capsule(self):
        (self.repo / 'src/link').symlink_to('/tmp/foreign-source')
        self.git('add', 'src/link')
        self.git('commit', '-qm', 'link fixture')
        pin = self.git('rev-parse', 'HEAD').strip()
        output = self.root / 'with-link'
        with self.assertRaises(ValueError):
            private.create_capsule(self.repo, pin, output)
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
