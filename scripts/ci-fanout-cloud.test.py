#!/usr/bin/env python3
"""Remote-controller safety regressions. Every provider/host effect is a fake."""
from __future__ import annotations

import copy
import base64
import io
import tarfile
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('fanout_cloud', Path(__file__).with_name('ci-fanout-cloud.py'))
cloud = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cloud)
LAUNCH_SPEC = importlib.util.spec_from_file_location('fanout_cloud_launch', Path(__file__).with_name('ci-fanout-cloud-launch.py'))
launch = importlib.util.module_from_spec(LAUNCH_SPEC)
LAUNCH_SPEC.loader.exec_module(launch)
SHA = 'a' * 40
ACCOUNT = '11111111-1111-1111-1111-111111111111'
VOLUME = '22222222-2222-2222-2222-222222222222'
START = dt.datetime.now(dt.timezone.utc).replace(microsecond=0) - dt.timedelta(minutes=10)
NOW = START + dt.timedelta(minutes=10)
DEADLINE = START + dt.timedelta(hours=1)
FILES = ('manifest.json', 'atomic-server-binary', 'client.oci.tar', 'checks.oci.tar', 'test-inventory.json')


def configuration(root):
    private = root / 'private'
    repo, mount = root / 'repo', root / 'volume'
    return {
        'batch_key': 'fixture-cloud', 'source_commit': SHA,
        'campaign_started_at': START.isoformat(), 'deadline': DEADLINE.isoformat(),
        'max_total_usd': 7.50,
        'account': {'context': 'personal', 'expected_uuid': ACCOUNT},
        'controller': {'name': 'fixture-cloud-control', 'size': 's-2vcpu-4gb',
                       'expected_hourly_rate': .04, 'ssh_key_id': 123,
                       'ssh_key_name': 'fixture-cloud-control-key', 'ssh_key_fingerprint': 'aa:bb',
                       'ownership_tag': 'fixture-cloud-owned', 'creation_intent_at': START.isoformat()},
        'volume': {'id': VOLUME, 'name': 'fixture-cache', 'size_gigabytes': 10,
                   'region': 'mem1', 'mount_path': str(mount)},
        'root': str(private), 'repo': str(repo), 'credentials': str(private / 'doctl.json'),
        'fanout_config': {
            'batch_key': 'fixture-cloud', 'test_run_key': 'fixture-cloud', 'source_commit': SHA,
            'worktree': str(repo), 'runtime_dir': str(private / 'runtime'),
            'doctl_config': str(private / 'doctl.json'),
            'accounts': [{'context': 'personal', 'expected_uuid': ACCOUNT, 'nodes': 3}],
            'region': 'mem1', 'size': 'g5-64vcpu-128gb-80gb', 'max_hours': 1,
            'absolute_deadline': DEADLINE.isoformat(), 'expected_hourly_rate': 1.5,
            'expected_volume_hourly_rate': .01, 'max_total_usd': 7.50,
            'authorization': 'Run only the reviewed three-node fixture within the fixed hour and budget.',
            'artifact_archive_dir': str(mount / 'browser-bundles'),
            'host_bundle_backup': True,
            'source_snapshots': {'personal': {'id': 'fixture-snapshot', 'name': 'fixture-reviewed'}},
        },
    }


def make_archive(root, source=SHA):
    root.mkdir(parents=True)
    bundle = root / 'bundle'
    bundle.mkdir()
    for name in FILES[1:]:
        (bundle / name).write_text('fixture payload ' + name)
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    manifest = {'version': 2, 'sourceCommit': source, 'platform': 'linux/amd64',
                'files': {name: digest(bundle / name) for name in FILES[1:]}}
    (bundle / 'manifest.json').write_text(json.dumps(manifest))
    receipt = {'version': 1, 'source_commit': source, 'build_exit_code': 0,
               'manifest_sha256': digest(bundle / 'manifest.json')}
    (root / 'build-receipt.json').write_text(json.dumps(receipt))
    (root / 'COMPLETED').write_text(digest(root / 'build-receipt.json') + '\n')
    return root


class FakeAPI:
    def __init__(self, config):
        self.config = config
        self.account_uuid = ACCOUNT
        self.calls = []
        self.deleted = []
        controller = config['controller']
        self.records = {99: {
            'id': 99, 'name': controller['name'], 'created_at': (START + dt.timedelta(seconds=1)).isoformat(),
            'size_slug': controller['size'], 'size': {'price_hourly': controller['expected_hourly_rate']},
            'region': {'slug': config['volume']['region']}, 'volume_ids': [VOLUME],
            'tags': [controller['ownership_tag']],
        }}
        self.volume_record = {
            'id': VOLUME, 'name': config['volume']['name'], 'size_gigabytes': 10,
            'region': {'slug': config['volume']['region']}, 'droplet_ids': [99], 'filesystem_type': 'ext4',
        }
        self.key_records = [{'id': 123, 'name': controller['ssh_key_name'],
                             'fingerprint': controller['ssh_key_fingerprint']}]

    def identity(self):
        self.calls.append(('identity',))
        if self.account_uuid != self.config['account']['expected_uuid']:
            raise ValueError('account UUID mismatch')
        return {'uuid': self.account_uuid}

    def droplets(self):
        self.calls.append(('droplets',))
        return copy.deepcopy(list(self.records.values()))

    def droplet(self, ident):
        self.calls.append(('droplet', ident))
        return copy.deepcopy(self.records.get(int(ident)))

    def volume(self, ident):
        self.calls.append(('volume', ident))
        if ident != VOLUME:
            raise AssertionError('Unexpected volume lookup: ' + str(ident))
        return copy.deepcopy(self.volume_record)

    def keys(self):
        self.calls.append(('keys',))
        return copy.deepcopy(self.key_records)

    def delete_droplet(self, ident):
        self.deleted.append(('droplet', int(ident)))
        self.records.pop(int(ident), None)
        self.volume_record['droplet_ids'] = [n for n in self.volume_record['droplet_ids'] if n != int(ident)]

    def delete_key(self, ident):
        self.deleted.append(('key', int(ident)))
        self.key_records = [key for key in self.key_records if key['id'] != int(ident)]


class CloudTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = cloud.validate_config(configuration(self.root))
        Path(self.config['root']).mkdir()
        Path(self.config['repo']).mkdir()
        Path(self.config['volume']['mount_path']).mkdir()
        Path(self.config['credentials']).write_text(json.dumps({'context':'personal','auth-contexts':{'personal':'dop_v1_FIXTURE_SECRET'}}))
        self.metadata = {'droplet_id': 99, 'hostname': 'fixture-cloud-control', 'region': 'mem1'}
        self.api = FakeAPI(self.config)

    def test_valid_configuration_retains_original_deadline_and_three_worker_scope(self):
        result = cloud.validate_config(copy.deepcopy(self.config))
        self.assertEqual(result['deadline'], self.config['deadline'])
        self.assertEqual(result['fanout_config']['absolute_deadline'], self.config['deadline'])
        self.assertEqual(sum(a['nodes'] for a in result['fanout_config']['accounts']), 3)

    def test_invalid_time_and_provenance_never_reach_bootstrap(self):
        mutations = [
            lambda c: c.update(deadline=(START + dt.timedelta(hours=2)).isoformat()),
            lambda c: c['fanout_config'].update(absolute_deadline=(DEADLINE + dt.timedelta(seconds=1)).isoformat()),
            lambda c: c['fanout_config'].update(source_commit='b' * 40),
            lambda c: c['fanout_config']['accounts'][0].update(expected_uuid='33333333-3333-3333-3333-333333333333'),
        ]
        for change in mutations:
            with self.subTest(change=change):
                config = copy.deepcopy(self.config)
                change(config)
                with self.assertRaises(ValueError):
                    cloud.validate_config(config)

    def test_verified_controller_and_own_attached_volume_are_accepted(self):
        self.assertEqual(cloud.verify_controller(self.config, self.api, self.metadata)['id'], 99)
        self.assertEqual(cloud.verify_volume(self.config, self.api, 99)['id'], VOLUME)
        self.assertEqual(self.api.deleted, [])

    def test_controller_identity_region_name_size_and_creation_must_match(self):
        mutations = [
            lambda a: a.records[99].update(id=100),
            lambda a: a.records[99].update(name='foreign-controller'),
            lambda a: a.records[99].update(region={'slug': 'elsewhere'}),
            lambda a: a.records[99].update(size_slug='unapproved-large-machine'),
            lambda a: a.records[99].update(created_at=(START - dt.timedelta(minutes=1)).isoformat()),
        ]
        for change in mutations:
            with self.subTest(change=change):
                api = FakeAPI(self.config)
                change(api)
                with self.assertRaises(ValueError):
                    cloud.verify_controller(self.config, api, self.metadata)
                self.assertEqual(api.deleted, [])

    def test_wrong_account_is_rejected_before_volume_or_cleanup(self):
        self.api.account_uuid = '33333333-3333-3333-3333-333333333333'
        with self.assertRaises(ValueError):
            cloud.verify_controller(self.config, self.api, self.metadata)
        self.assertEqual(self.api.deleted, [])

    def test_volume_id_name_size_region_and_foreign_attachment_are_not_adopted(self):
        mutations = [
            lambda a: a.volume_record.update(id='33333333-3333-3333-3333-333333333333'),
            lambda a: a.volume_record.update(name='foreign-volume'),
            lambda a: a.volume_record.update(size_gigabytes=100),
            lambda a: a.volume_record.update(region={'slug': 'elsewhere'}),
            lambda a: a.volume_record.update(droplet_ids=[99, 888]),
            lambda a: a.volume_record.update(droplet_ids=[888]),
        ]
        for change in mutations:
            with self.subTest(change=change):
                api = FakeAPI(self.config)
                change(api)
                with self.assertRaises(ValueError):
                    cloud.verify_volume(self.config, api, 99)
                self.assertEqual(api.deleted, [])

    def test_expired_bootstrap_never_executes_installs_git_or_worker_commands(self):
        config = copy.deepcopy(self.config)
        config['campaign_started_at'] = (START - dt.timedelta(hours=2)).isoformat()
        config['deadline'] = (DEADLINE - dt.timedelta(hours=2)).isoformat()
        config['fanout_config']['absolute_deadline'] = config['deadline']
        config['controller']['creation_intent_at'] = config['campaign_started_at']
        with mock.patch.object(cloud.subprocess, 'run', side_effect=AssertionError('no subprocess before deadline guard')) as run:
            with self.assertRaises(TimeoutError):
                cloud.bootstrap_run(config, api=self.api, metadata=self.metadata)
        run.assert_not_called()
        self.assertEqual(self.api.deleted, [])

    def test_complete_verified_matching_bundle_is_accepted_without_a_rebuild(self):
        make_archive(Path(self.config['fanout_config']['artifact_archive_dir']) / (SHA + '-linux-amd64-v2'))
        with mock.patch.object(cloud.subprocess, 'run', side_effect=AssertionError('cache validation must not build or install')):
            entries = cloud.validate_cached_bundles(self.config)
        self.assertEqual(len(entries), 1)

    def test_incomplete_or_mismatched_bundle_is_never_reported_as_valid(self):
        cache = Path(self.config['fanout_config']['artifact_archive_dir'])
        entry = cache / (SHA + '-linux-amd64-v2')
        mutations = [
            lambda: (entry / 'COMPLETED').unlink(),
            lambda: (entry / 'bundle/checks.oci.tar').unlink(),
            lambda: (entry / 'bundle/checks.oci.tar').write_text('wrong bytes'),
            lambda: (entry / 'build-receipt.json').write_text('{}'),
            lambda: (entry / 'COMPLETED').write_text('0' * 64),
        ]
        for change in mutations:
            with self.subTest(change=change):
                if entry.exists():
                    shutil.rmtree(entry)
                make_archive(entry)
                change()
                try:
                    entries = cloud.validate_cached_bundles(self.config)
                except (ValueError, FileNotFoundError):
                    entries = []
                self.assertEqual(entries, [])

    def test_symlinked_bundle_payload_is_not_a_cache_hit(self):
        entry = make_archive(Path(self.config['fanout_config']['artifact_archive_dir']) / (SHA + '-linux-amd64-v2'))
        payload = entry / 'bundle/checks.oci.tar'
        outside = self.root / 'outside-payload'
        payload.rename(outside)
        payload.symlink_to(outside)
        try:
            entries = cloud.validate_cached_bundles(self.config)
        except ValueError:
            entries = []
        self.assertEqual(entries, [])

    def write_state(self, nodes):
        runtime = Path(self.config['fanout_config']['runtime_dir'])
        runtime.mkdir(parents=True, exist_ok=True)
        (runtime / 'state.json').write_text(json.dumps({'nodes': nodes, 'keys': {}, 'batch_key': self.config['batch_key'], 'source_commit': SHA, 'config': self.config['fanout_config']}))

    def worker(self, ident=201, **overrides):
        created = (START + dt.timedelta(seconds=2)).isoformat()
        record = {'id': ident, 'name': 'fixture-cloud-node-001', 'created_at': created,
                  'size_slug': self.config['fanout_config']['size'], 'size': {'price_hourly': 1.5},
                  'region': {'slug': 'mem1'}, 'volume_ids': []}
        record.update(overrides)
        self.api.records[ident] = record
        return {'id': 'node-001', 'account': 'personal', 'name': record['name'], 'droplet_id': ident,
                'created_at': created, 'creation_attempted_at': (START + dt.timedelta(seconds=1)).isoformat(),
                'creation_absence_verified': True, 'creation_account_uuid': ACCOUNT}

    def reap(self, now=None):
        with mock.patch.object(cloud, 'command', return_value=subprocess.CompletedProcess([], 0, stdout='active')) as command, \
             mock.patch.object(cloud, 'ensure_volume_mounted', return_value=Path(self.config['volume']['mount_path'])), \
             mock.patch.object(cloud, 'persist_evidence', return_value={}):
            result = cloud.reap_once(self.config, api=self.api, now=now or DEADLINE, metadata=self.metadata)
        return result

    def test_stdlib_reaper_cleans_owned_worker_and_itself_without_bootstrap_tools(self):
        self.write_state({'node-001': self.worker()})
        with mock.patch.object(cloud.subprocess, 'run', side_effect=AssertionError('doctl/git must not be required')):
            result = self.reap()
        self.assertTrue(result['cleanup_complete'])
        self.assertTrue(result['self_delete_requested'])
        self.assertEqual(result['worker_ids_deleted'], [201])
        self.assertEqual(self.api.deleted, [('droplet', 201), ('key', 123), ('droplet', 99)])
        self.assertEqual(self.api.volume_record['id'], VOLUME)

    def test_no_deadline_or_finalize_means_no_provider_deletion(self):
        self.write_state({'node-001': self.worker()})
        result = self.reap(now=NOW)
        self.assertFalse(result['self_delete_requested'])
        self.assertEqual(self.api.deleted, [])

    def test_reaper_does_not_delete_controller_with_an_unattempted_live_worker(self):
        ledger = self.worker()
        ledger.update(droplet_id=None, creation_attempted_at=None)
        self.write_state({'node-001': ledger})
        result = self.reap()
        self.assertFalse(result['cleanup_complete'])
        self.assertFalse(result['self_delete_requested'])
        self.assertNotIn(('droplet', 99), self.api.deleted)
        self.assertNotIn(('droplet', 201), self.api.deleted)

    def test_duplicate_same_name_is_not_adopted_and_blocks_controller_deletion(self):
        ledger = self.worker()
        self.api.records[202] = dict(self.api.records[201], id=202)
        self.write_state({'node-001': ledger})
        result = self.reap()
        self.assertFalse(result['cleanup_complete'])
        self.assertFalse(result['self_delete_requested'])
        self.assertNotIn(('droplet', 202), self.api.deleted)
        self.assertNotIn(('droplet', 99), self.api.deleted)

    def test_recorded_worker_mismatched_name_time_or_id_is_never_deleted(self):
        for change in ({'id': 202}, {'name': 'foreign-worker'},
                       {'created_at': (START - dt.timedelta(minutes=1)).isoformat()}):
            with self.subTest(change=change):
                self.api = FakeAPI(self.config)
                self.write_state({'node-001': self.worker(**change)})
                result = self.reap()
                self.assertFalse(result['cleanup_complete'])
                self.assertNotIn(('droplet', 201), self.api.deleted)
                self.assertNotIn(('droplet', 99), self.api.deleted)

    def test_unknown_recent_worker_creation_keeps_controller_alive(self):
        ledger = self.worker()
        self.api.records.pop(201)
        ledger.update(droplet_id=None, creation_attempted_at=(DEADLINE - dt.timedelta(seconds=30)).isoformat())
        self.write_state({'node-001': ledger})
        result = self.reap()
        self.assertFalse(result['cleanup_complete'])
        self.assertFalse(result['self_delete_requested'])
        self.assertNotIn(('droplet', 99), self.api.deleted)

    def test_mount_observation_must_name_the_exact_ext4_device_and_target(self):
        device = '/dev/disk/by-id/scsi-0DO_Volume_fixture-cache'
        observation = {'target': self.config['volume']['mount_path'], 'source': device, 'fstype': 'ext4'}
        with mock.patch.object(cloud, 'command', side_effect=AssertionError('injected observation needs no shell')):
            self.assertEqual(cloud.verify_mount(self.config, device=device, observation=observation), Path(observation['target']))
            for field, value in [('source', '/dev/foreign'), ('target', '/another-mount'), ('fstype', 'xfs')]:
                with self.subTest(field=field), self.assertRaises(ValueError):
                    cloud.verify_mount(self.config, device=device, observation=dict(observation, **{field: value}))

    def test_existing_foreign_mount_is_refused_without_mounting_over_it(self):
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if args[0] == 'findmnt':
                return subprocess.CompletedProcess(args, 0, stdout=json.dumps({'filesystems': [{'target': self.config['volume']['mount_path'],
                                                   'source': '/dev/foreign', 'fstype': 'ext4'}]}))
            if args[0] == 'blkid':
                return 'ext4'
            raise AssertionError('must not alter an already-mounted foreign filesystem: ' + repr(args))
        with mock.patch.object(cloud, 'command', side_effect=command), self.assertRaises(ValueError):
            cloud.ensure_volume_mounted(self.config)
        self.assertFalse(any(args[0] in ('mount', 'mkfs', 'mkfs.ext4') for args in calls))

    def test_unformatted_retained_device_is_never_formatted(self):
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if args[0] == 'findmnt':
                return subprocess.CompletedProcess(args, 1, stdout='')
            if args[0] == 'blkid':
                return ''
            raise AssertionError('must not format device: ' + repr(args))
        with mock.patch.object(cloud, 'command', side_effect=command), self.assertRaises(ValueError):
            cloud.ensure_volume_mounted(self.config)
        self.assertFalse(any('mkfs' in part for args in calls for part in args))

    def test_persist_allowlist_keeps_results_but_excludes_credentials_private_keys_and_symlinks(self):
        runtime = Path(self.config['fanout_config']['runtime_dir'])
        files = {
            'state.json': json.dumps({'status': 'failed', 'source_commit': SHA}),
            'browser-merged.json': '{"failed":1}',
            'node-001/results/browser/report.json': '{"result":"original evidence"}',
            'node-001/results/browser/traces/failure.zip': 'fixture trace bytes',
            'doctl.yaml': 'dop_v1_FIXTURE_SECRET',
            'node-001/results/doctl.yaml': 'nested credential',
            'operator-key': '-----BEGIN OPENSSH PRIVATE KEY-----',
            'artifact-cache/client.oci.tar': 'large cache excluded from report collection',
            'node-001/results/browser/accidental-secret.log': 'leaked dop_v1_FIXTURE_SECRET',
            'node-001/results/browser/private-key.log': '-----BEGIN OPENSSH PRIVATE KEY-----',
        }
        for name, text in files.items():
            path = runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        outside = self.root / 'outside-secret'
        outside.write_text('must not follow this link')
        (runtime / 'node-001/results/browser/linked-report.json').symlink_to(outside)
        (runtime / 'node-001/results/linked-dir').symlink_to(outside.parent, target_is_directory=True)
        with mock.patch.object(cloud, 'verify_mount', return_value=Path(self.config['volume']['mount_path'])):
            receipt = cloud.persist_evidence(self.config)
        retained = Path(self.config['volume']['mount_path']) / 'runs/fixture-cloud/runtime'
        self.assertEqual((retained / 'node-001/results/browser/report.json').read_text(), files['node-001/results/browser/report.json'])
        self.assertTrue((retained / 'node-001/results/browser/traces/failure.zip').is_file())
        for name in ('doctl.yaml', 'node-001/results/doctl.yaml', 'operator-key', 'artifact-cache/client.oci.tar',
                     'node-001/results/browser/linked-report.json', 'node-001/results/linked-dir',
                     'node-001/results/browser/accidental-secret.log', 'node-001/results/browser/private-key.log'):
            self.assertFalse((retained / name).exists(), name)
        self.assertIn('runtime/node-001/results/browser/accidental-secret.log', receipt['excluded_private_files'])
        self.assertEqual((runtime / 'node-001/results/browser/report.json').read_text(), files['node-001/results/browser/report.json'])
        self.assertNotIn('dop_v1_FIXTURE_SECRET', json.dumps(receipt))

    def test_nonfinite_prices_and_budget_are_rejected(self):
        for value in (float('nan'), float('inf'), -float('inf')):
            for field in ('controller_rate', 'worker_rate', 'volume_rate', 'budget', 'egress'):
                with self.subTest(value=value, field=field):
                    config = copy.deepcopy(self.config)
                    if field == 'controller_rate':
                        config['controller']['expected_hourly_rate'] = value
                    elif field == 'worker_rate':
                        config['fanout_config']['expected_hourly_rate'] = value
                    elif field == 'volume_rate':
                        config['expected_volume_hourly_rate'] = value
                    elif field == 'egress':
                        config['cloud_egress_reserve_usd'] = value
                    else:
                        config['max_total_usd'] = value
                    with self.assertRaises(ValueError):
                        cloud.validate_config(config)

    def test_repeated_reaping_preserves_original_worker_deletion_time_and_cost(self):
        self.write_state({'node-001': self.worker()})
        self.reap(now=DEADLINE)
        # Keep the control VM reachable to simulate delayed provider self-deletion.
        self.api.records[99] = FakeAPI(self.config).records[99]
        self.api.volume_record['droplet_ids'] = [99]
        first = json.loads((Path(self.config['fanout_config']['runtime_dir']) / 'state.json').read_text())
        first_time = first['nodes']['node-001']['deleted_at']
        self.reap(now=DEADLINE + dt.timedelta(minutes=5))
        second = json.loads((Path(self.config['fanout_config']['runtime_dir']) / 'state.json').read_text())
        self.assertEqual(second['nodes']['node-001']['deleted_at'], first_time)
        self.assertGreater(first['nodes']['node-001']['compute_usd'], 0)
        self.assertEqual(second['nodes']['node-001']['compute_usd'], first['nodes']['node-001']['compute_usd'])

    def test_periodic_cache_proof_skips_rehash_but_final_proof_rehashes_and_detects_changes(self):
        entry = make_archive(Path(self.config['fanout_config']['artifact_archive_dir']) / (SHA + '-linux-amd64-v2'))
        with mock.patch.object(cloud, 'sha256', wraps=cloud.sha256) as digest:
            self.assertEqual(len(cloud.validate_cached_bundles(self.config, force=False)), 1)
            initial_hashes = digest.call_count
            self.assertGreater(initial_hashes, 0)
            self.assertEqual(len(cloud.validate_cached_bundles(self.config, force=False)), 1)
            self.assertEqual(digest.call_count, initial_hashes)
            self.assertEqual(len(cloud.validate_cached_bundles(self.config, force=True)), 1)
            self.assertGreater(digest.call_count, initial_hashes)
            payload = entry / 'bundle/checks.oci.tar'
            old_mtime = payload.stat().st_mtime_ns
            payload.write_bytes(b'x' * payload.stat().st_size)
            os.utime(payload, ns=(old_mtime, old_mtime))
            self.assertEqual(cloud.validate_cached_bundles(self.config, force=False), [])

    def test_other_commit_bundle_is_not_reported_as_build_for_current_commit(self):
        make_archive(Path(self.config['fanout_config']['artifact_archive_dir']) / ('b' * 40 + '-linux-amd64-v2'), source='b' * 40)
        with mock.patch.object(cloud, 'verify_mount', return_value=Path(self.config['volume']['mount_path'])):
            receipt = cloud.persist_evidence(self.config, final=True)
        self.assertFalse(receipt['cache_preserved_for_source'])
        self.assertEqual(receipt['source_commit'], SHA)
        self.assertEqual(receipt['validated_caches'][0]['source_commit'], 'b' * 40)

    def test_persist_refreshes_changed_report_despite_identical_length_and_restored_mtime(self):
        report = Path(self.config['fanout_config']['runtime_dir']) / 'node-001/results/report.json'
        report.parent.mkdir(parents=True)
        report.write_text('{"failed":1}')
        with mock.patch.object(cloud, 'verify_mount', return_value=Path(self.config['volume']['mount_path'])):
            cloud.persist_evidence(self.config)
            before = report.stat()
            report.write_text('{"failed":0}')
            os.utime(report, ns=(before.st_atime_ns, before.st_mtime_ns))
            cloud.persist_evidence(self.config, final=True)
        target = Path(self.config['volume']['mount_path']) / 'runs/fixture-cloud/runtime/node-001/results/report.json'
        self.assertEqual(target.read_text(), '{"failed":0}')

    def test_foreign_runtime_batch_source_or_account_cannot_authorize_cleanup(self):
        for field in ('batch', 'source', 'account'):
            with self.subTest(field=field):
                self.api = FakeAPI(self.config)
                self.write_state({'node-001': self.worker()})
                path = Path(self.config['fanout_config']['runtime_dir']) / 'state.json'
                state = json.loads(path.read_text())
                if field == 'batch':
                    state['batch_key'] = 'other-campaign'
                elif field == 'source':
                    state['source_commit'] = 'b' * 40
                else:
                    state['config']['accounts'][0]['expected_uuid'] = '33333333-3333-3333-3333-333333333333'
                path.write_text(json.dumps(state))
                try:
                    result = self.reap()
                except ValueError:
                    result = {'cleanup_complete':False, 'self_delete_requested':False}
                self.assertFalse(result['cleanup_complete'])
                self.assertFalse(result['self_delete_requested'])
                self.assertEqual(self.api.deleted, [])

    def test_total_budget_counts_the_remote_controller(self):
        # Workers alone fit exactly; adding the control node must reject it.
        config = copy.deepcopy(self.config)
        config['max_total_usd'] = 4.5
        config['fanout_config']['max_total_usd'] = 4.5
        with self.assertRaisesRegex(ValueError, 'budget|cost|maximum|max_total'):
            cloud.validate_config(config)


class LauncherAPI:
    def __init__(self, config):
        self.config = config
        self.config_path = config['doctl_config']
        self.calls, self.creates = [], []
        self.volumes, self.droplets, self.keys = [], [], []
        self.on_create = None

    def identity(self, account):
        if account['expected_uuid'] != ACCOUNT:
            raise ValueError('wrong account')
        return {'uuid': ACCOUNT, 'droplet_limit': 10}

    def call(self, account, args):
        self.identity(account)
        self.calls.append(list(args))
        if args == ['compute', 'droplet', 'list']:
            return copy.deepcopy(self.droplets)
        if args == ['compute', 'volume', 'list']:
            return copy.deepcopy(self.volumes)
        if args == ['compute', 'ssh-key', 'list']:
            return copy.deepcopy(self.keys)
        if args == ['compute', 'size', 'list']:
            return [{'slug': self.config['size'], 'vcpus': 64, 'available': True,
                     'regions': ['mem1'], 'price_hourly': 1.5},
                    {'slug': self.config['cloud_controller_size'], 'vcpus': 2, 'available': True,
                     'regions': ['mem1'], 'price_hourly': .04}]
        if args[:3] == ['compute', 'volume', 'get']:
            return [copy.deepcopy(next(v for v in self.volumes if v['id'] == args[3]))]
        if args[:3] == ['compute', 'volume', 'create']:
            self.creates.append(list(args))
            record = {'id': VOLUME, 'name': args[3], 'size_gigabytes': 10,
                      'region': {'slug': 'mem1'}, 'filesystem_type': 'ext4', 'droplet_ids': [],
                      'created_at': NOW.isoformat(), 'description': args[args.index('--desc') + 1]}
            self.volumes.append(record)
            return [copy.deepcopy(record)]
        if args[:3] == ['compute', 'ssh-key', 'import']:
            self.creates.append(list(args))
            public = Path(args[args.index('--public-key-file') + 1]).read_text().strip()
            raw = hashlib.md5(base64.b64decode(public.split()[1])).hexdigest()
            record = {'id': 123, 'name': args[3], 'public_key': public,
                      'fingerprint': ':'.join(raw[i:i+2] for i in range(0, 32, 2))}
            self.keys.append(record)
            return [copy.deepcopy(record)]
        if args[:3] == ['compute', 'droplet', 'create']:
            self.creates.append(list(args))
            if self.on_create:
                self.on_create(args)
            record = {'id': 99, 'name': args[3], 'created_at': NOW.isoformat(),
                      'size_slug': self.config['cloud_controller_size'], 'size': {'price_hourly': .04},
                      'region': {'slug': 'mem1'}, 'tags': [args[args.index(next(flag for flag in ('--tag-names','--tag-name','--tag') if flag in args)) + 1]],
                      'networks': {'v4': [{'type': 'public', 'ip_address': '192.0.2.99'}]}}
            self.droplets.append(record)
            return [copy.deepcopy(record)]
        raise AssertionError('unexpected provider call: ' + repr(args))


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = copy.deepcopy(configuration(self.root)['fanout_config'])
        self.config.update(runtime_dir=str(self.root / 'launch-runtime'), doctl_config=str(self.root / 'credentials.json'),
                           cloud_controller_size='s-2vcpu-4gb', expected_controller_hourly_rate=.04,
                           cloud_volume_name='fixture-cache', expected_volume_hourly_rate=.0015,
                           cloud_egress_reserve_usd=.15)
        self.config.pop('absolute_deadline')
        Path(self.config['doctl_config']).write_text(json.dumps({'context':'work', 'auth-contexts':
                                                    {'personal':'dop_v1_PERSONAL_FIXTURE', 'work':'dop_v1_OTHER_ACCOUNT'}}))
        self.api = LauncherAPI(self.config)
        self.scripts = {'ci-fanout-cloud-launch.py': Path(launch.__file__).read_bytes(), 'ci-fanout-cloud.py': Path(cloud.__file__).read_bytes()}
        self.worker_plan = {'check_jobs': ['check-' + str(i) for i in range(10)]}
        self.clock = NOW
        self.controller = launch.CloudLauncher(self.config, api=self.api, run=self.run_command, now=lambda: self.clock)

    def run_command(self, args, **kwargs):
        if args[0] == 'ssh-keygen':
            path = Path(args[args.index('-f') + 1])
            path.write_text('fixture private key')
            path.with_name(path.name + '.pub').write_text('ssh-ed25519 ' + base64.b64encode(b'fixture-public-key').decode())
            return ''
        raise AssertionError('test must not execute shell/SSH: ' + repr(args))

    def source_plan(self):
        return mock.patch.object(launch, 'checked_source', return_value=self.scripts)

    def test_readonly_plan_includes_control_storage_cleanup_and_egress(self):
        with self.source_plan(), mock.patch.object(launch.BASE.Controller, 'plan', return_value=self.worker_plan):
            plan = self.controller.plan()
        self.assertEqual(plan['test_nodes'], 3)
        self.assertEqual(plan['persistent_volume_gib'], 10)
        self.assertEqual(plan['cleanup_reserve_seconds'], 120)
        self.assertAlmostEqual(plan['hourly_usd'], 4.5415)
        self.assertAlmostEqual(plan['maximum_estimated_usd'], 4.5415 * (1 + 120 / 3600) + .15)
        self.assertEqual(self.api.creates, [])
        self.assertFalse(Path(self.config['runtime_dir']).exists())

    def test_one_hour_plan_accepts_a_realistically_ticking_clock(self):
        observed = []
        def ticking_clock():
            value = NOW + dt.timedelta(microseconds=len(observed))
            observed.append(value)
            return value
        controller = launch.CloudLauncher(self.config, api=self.api, run=self.run_command, now=ticking_clock)
        with self.source_plan(), mock.patch.object(launch.BASE.Controller, 'plan', return_value=self.worker_plan):
            plan = controller.plan()
        self.assertEqual(plan['maximum_hours'], 1)
        self.assertEqual(observed, [NOW])
        self.assertEqual(self.api.creates, [])
        self.assertFalse(Path(self.config['runtime_dir']).exists())

    def test_failed_worker_plan_prevents_any_cloud_create_or_local_journal(self):
        with self.source_plan(), mock.patch.object(launch.BASE.Controller, 'plan', side_effect=ValueError('invalid source inventory')):
            with self.assertRaisesRegex(ValueError, 'invalid source inventory'):
                self.controller.launch()
        self.assertEqual(self.api.creates, [])
        self.assertFalse(Path(self.config['runtime_dir']).exists())

    def test_insufficient_total_budget_fails_before_first_paid_mutation(self):
        config = dict(self.config, max_total_usd=4.70)
        controller = launch.CloudLauncher(config, api=self.api, run=self.run_command, now=lambda: NOW)
        with self.source_plan(), mock.patch.object(launch.BASE.Controller, 'plan', return_value=self.worker_plan), self.assertRaisesRegex(ValueError, 'budget'):
            controller.launch()
        self.assertEqual(self.api.creates, [])
        self.assertFalse(Path(config['runtime_dir']).exists())

    def test_name_collision_requires_explicit_retained_volume_id(self):
        self.api.volumes = [{'id': VOLUME, 'name': 'fixture-cache', 'size_gigabytes': 10,
                             'region': {'slug': 'mem1'}, 'filesystem_type': 'ext4', 'droplet_ids': []}]
        with self.source_plan(), mock.patch.object(launch.BASE.Controller, 'plan', return_value=self.worker_plan), self.assertRaisesRegex(ValueError, 'explicit'):
            self.controller.launch()
        self.assertEqual(self.api.creates, [])
        controller = launch.CloudLauncher(dict(self.config, cloud_volume_id=VOLUME), api=self.api, run=self.run_command, now=lambda: NOW)
        with self.source_plan(), mock.patch.object(launch.BASE.Controller, 'plan', return_value=self.worker_plan):
            controller.plan()
        self.assertEqual(self.api.creates, [])

    def test_oversized_userdata_is_rejected_before_any_paid_create(self):
        scripts = dict(self.scripts, **{'ci-fanout-cloud.py': self.scripts['ci-fanout-cloud.py'] + b'\n# ' + b'x' * (65 * 1024)})
        with mock.patch.object(launch, 'checked_source', return_value=scripts), \
             mock.patch.object(launch.BASE.Controller, 'plan', return_value=self.worker_plan), \
             self.assertRaisesRegex(ValueError, '64|user.?data|large|limit'):
            self.controller.launch()
        self.assertEqual(self.api.creates, [])
        self.assertFalse(Path(self.config['runtime_dir']).exists())

    def test_only_the_selected_account_credential_is_exported(self):
        value = launch.selected_credentials(self.config['doctl_config'], 'personal')
        self.assertEqual(value, {'context': 'personal', 'auth-contexts': {'personal':'dop_v1_PERSONAL_FIXTURE'}})
        self.assertNotIn('OTHER_ACCOUNT', json.dumps(value))
        with self.assertRaises(ValueError):
            launch.selected_credentials(self.config['doctl_config'], 'missing')

    def test_detached_userdata_arms_independent_reaper_before_bootstrap(self):
        import yaml
        remote = configuration(self.root)
        credentials = {'context':'personal','auth-contexts':{'personal':'fixture-secret'}}
        data = yaml.safe_load(launch.cloud_init(b'fixture stdlib supervisor', remote, credentials))
        commands = data['runcmd']
        self.assertEqual(commands[1], ['systemctl','enable','--now','atomic-ci-reaper-fixture-cloud.service'])
        self.assertEqual(commands[2], ['systemctl','enable','--now','atomic-ci-supervisor-fixture-cloud.service'])
        self.assertNotIn('packages', data)
        files = {f['path']: base64.b64decode(f['content']).decode() for f in data['write_files']}
        reaper = files['/etc/systemd/system/atomic-ci-reaper-fixture-cloud.service']
        supervisor = files['/etc/systemd/system/atomic-ci-supervisor-fixture-cloud.service']
        self.assertIn('KillMode=control-group', reaper)
        self.assertIn('KillMode=control-group', supervisor)
        self.assertIn('Restart=always', reaper)
        self.assertIn('Restart=no', supervisor)
        self.assertIn(' reap', reaper)
        self.assertIn(' bootstrap-run', supervisor)
        self.assertNotIn('ssh ', supervisor + reaper)
        self.assertEqual(files['/root/atomic-ci-control/ci-fanout-cloud.py'], 'fixture stdlib supervisor')

    def test_controller_first_request_freezes_deadline_and_relaunch_cannot_extend_it(self):
        observed = {}
        def on_create(args):
            state = json.loads(self.controller.path.read_text())
            observed.update(start=state['campaign_started_at'], deadline=state['deadline'])
            self.clock += dt.timedelta(minutes=7)
        self.api.on_create = on_create
        with self.source_plan(), mock.patch.object(launch.BASE.Controller, 'plan', return_value=self.worker_plan):
            self.controller.launch()
        state = self.controller.read()
        self.assertEqual(observed, {'start':NOW.isoformat(), 'deadline':(NOW+dt.timedelta(hours=1)).isoformat()})
        self.assertEqual(state['deadline'], observed['deadline'])
        before = list(self.api.creates)
        with self.assertRaises(ValueError):
            self.controller.launch()
        self.assertEqual(self.api.creates, before)
        self.assertFalse((self.controller.root / 'user-data.yaml').exists())
        argv = next(args for args in self.api.creates if args[:3] == ['compute','droplet','create'])
        self.assertNotIn('--tag', argv)
        self.assertTrue('--tag-names' in argv or '--tag-name' in argv)
        self.assertNotIn('dop_v1_OTHER_ACCOUNT', (self.controller.root / 'doctl-selected.json').read_text())

    def report_archive(self, members):
        path = self.root / 'reports.tar'
        with tarfile.open(path, 'w') as archive:
            for name, kind in members:
                info = tarfile.TarInfo(name)
                if kind == 'link':
                    info.type = tarfile.SYMTYPE
                    info.linkname = '/outside-secret'
                    archive.addfile(info)
                else:
                    payload = b'original report bytes'
                    info.size = len(payload)
                    archive.addfile(info, io.BytesIO(payload))
        return path

    def test_report_collection_preserves_native_report_and_rejects_sensitive_members(self):
        destination = self.root / 'collected'
        launch.extract_reports(self.report_archive([('reports/runtime/node-001/results/browser/report.json','file')]), destination)
        self.assertEqual((destination / 'reports/runtime/node-001/results/browser/report.json').read_bytes(), b'original report bytes')
        for name, kind in [('reports/browser-bundles/client.oci.tar','file'), ('reports/doctl.json','file'),
                           ('reports/runtime/doctl.yaml','file'), ('reports/operator-key','file'),
                           ('reports/id_ed25519','file'), ('reports/symlink','link'), ('../escape','file')]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                launch.extract_reports(self.report_archive([(name,kind)]), destination)


if __name__ == '__main__':
    unittest.main()
