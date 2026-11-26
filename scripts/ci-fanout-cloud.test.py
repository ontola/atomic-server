#!/usr/bin/env python3
"""Remote-controller safety regressions. Every provider/host effect is a fake."""
from __future__ import annotations

import copy
import base64
import io
import tarfile
import datetime as dt
import hashlib
import gzip
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

    def test_failed_startup_observation_is_retained_only_at_exact_node_evidence_path(self):
        runtime=Path(self.config['fanout_config']['runtime_dir'])
        observation={'engine_images':[],'restored_dagger_cache_nonempty':False}
        allowed='node-001/cache-startup-observation.json'
        rejected=('cache-startup-observation.json','node-1/cache-startup-observation.json',
                  'node-001-foreign/cache-startup-observation.json','node-001/cache-startup-observation.json.bak',
                  'node-001/nested/cache-startup-observation.json')
        for name in (allowed,*rejected):
            path=runtime/name; path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(json.dumps(observation))
        outside=self.root/'outside-observation.json'; outside.write_text('private outside file')
        linked=runtime/'node-002/cache-startup-observation.json'; linked.parent.mkdir(parents=True)
        linked.symlink_to(outside)
        with mock.patch.object(cloud,'verify_mount',return_value=Path(self.config['volume']['mount_path'])):
            cloud.persist_evidence(self.config)
        saved=Path(self.config['volume']['mount_path'])/'runs/fixture-cloud/runtime'
        self.assertEqual(json.loads((saved/allowed).read_text()),observation)
        for name in (*rejected,'node-002/cache-startup-observation.json'):
            self.assertFalse((saved/name).exists(),name)
        self.assertFalse((saved/'node-001/cache-startup.json').exists())

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

    def test_mutable_evidence_refreshes_even_when_all_file_stat_fields_are_identical(self):
        runtime = Path(self.config['fanout_config']['runtime_dir'])
        files = {'node-001/results/browser/test-results.json': ('{"failed":1}', '{"failed":0}'),
                 'node-001/results/browser/test-exit-code': ('1', '0')}
        for name, (before, _) in files.items():
            path = runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(before)
        original_stat = Path.stat
        frozen = {runtime / name: (runtime / name).stat() for name in files}
        def unchanged_metadata(path, *args, **kwargs):
            return frozen[path] if path in frozen else original_stat(path, *args, **kwargs)
        with mock.patch.object(cloud, 'verify_mount', return_value=Path(self.config['volume']['mount_path'])), \
             mock.patch.object(Path, 'stat', autospec=True, side_effect=unchanged_metadata):
            cloud.persist_evidence(self.config)
            for name, (_, after) in files.items():
                (runtime / name).write_text(after)
            cloud.persist_evidence(self.config)
        retained = Path(self.config['volume']['mount_path']) / 'runs/fixture-cloud/runtime'
        for name, (_, after) in files.items():
            self.assertEqual((retained / name).read_text(), after, name)

    def test_unchanged_large_trace_is_neither_rehashed_nor_recopied_on_each_preservation(self):
        trace = Path(self.config['fanout_config']['runtime_dir']) / 'node-001/results/browser/failure.zip'
        trace.parent.mkdir(parents=True)
        trace.write_bytes(b'x' * (1024 * 1024))
        original_open, writes = Path.open, []
        def observe_open(path, mode='r', *args, **kwargs):
            if path.name == 'failure.zip.tmp' and mode == 'wb':
                writes.append(path)
            return original_open(path, mode, *args, **kwargs)
        with mock.patch.object(cloud, 'verify_mount', return_value=Path(self.config['volume']['mount_path'])), \
             mock.patch.object(Path, 'open', autospec=True, side_effect=observe_open), \
             mock.patch.object(cloud, 'sha256', wraps=cloud.sha256) as hashes:
            cloud.persist_evidence(self.config)
            cloud.persist_evidence(self.config)
        self.assertEqual(len(writes), 1)
        self.assertNotIn(trace, [call.args[0] for call in hashes.call_args_list])

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

    def test_cold_remote_contract_rejects_ignored_snapshot_hints(self):
        for field,value in [('source_snapshot_id',SNAPSHOT),('source_snapshot_name','reviewed-seed'),
                            ('source_snapshot_profile',{'cache_namespace':'fixturewarm'})]:
            with self.subTest(field=field),self.assertRaises(ValueError):
                config=copy.deepcopy(self.config)
                config['fanout_config'][field]=value
                cloud.validate_config(config)

    def test_total_budget_counts_the_remote_controller(self):
        # Workers alone fit exactly; adding the control node must reject it.
        config = copy.deepcopy(self.config)
        config['max_total_usd'] = 4.5
        config['fanout_config']['max_total_usd'] = 4.5
        with self.assertRaisesRegex(ValueError, 'budget|cost|maximum|max_total'):
            cloud.validate_config(config)


CACHE_VOLUME = '33333333-3333-3333-3333-333333333333'
SNAPSHOT = '44444444-4444-4444-4444-444444444444'


def warm_configuration(root):
    config = configuration(root)
    config.update(cloud_worker_mode='warm', cloud_controller_region='mem1',
                  expected_volume_hourly_rate=.0015, expected_cache_volume_hourly_rate=.03)
    config['fanout_config'].update(region='atl1', cache_namespace='fixturewarm', expected_volume_hourly_rate=.03,
        artifact_cache_dir='/var/cache/atomic-ci/browser-bundles',
        source_snapshots={'personal': {'id': SNAPSHOT, 'name': 'reviewed-seed',
            'cache_namespace': 'fixturewarm', 'dagger_engine_version': '0.0.1',
            'architecture': 'linux/amd64', 'docker_data_root': '/mnt/atomic-ci/docker'}})
    return config


class WarmAPI(FakeAPI):
    def __init__(self, config):
        super().__init__(config)
        self.cache_volumes = {}
        self.snapshots = {SNAPSHOT: {'id': SNAPSHOT, 'name': 'reviewed-seed', 'resource_type': 'volume',
                                    'resource_id': 'seed-volume', 'regions': ['atl1'], 'min_disk_size': 200}}
        self.stale_volume_404 = False
        self.lose_volume_delete = False
        self.keep_volume_after_delete = False
        self.keep_attachment = False

    def volumes(self):
        self.calls.append(('volumes',))
        return copy.deepcopy([self.volume_record, *self.cache_volumes.values()])

    def volume(self, ident):
        if ident == VOLUME:
            return super().volume(ident)
        self.calls.append(('volume', ident))
        return None if self.stale_volume_404 else copy.deepcopy(self.cache_volumes.get(ident))

    def snapshot(self, ident):
        self.calls.append(('snapshot', ident))
        return copy.deepcopy(self.snapshots.get(ident))

    def delete_volume(self, ident):
        if ident == VOLUME or ident in self.snapshots:
            raise AssertionError('retained volume and source snapshot must never be deleted')
        self.deleted.append(('volume', ident))
        if not self.keep_volume_after_delete:
            self.cache_volumes.pop(ident, None)
        if self.lose_volume_delete:
            raise RuntimeError('lost delete response')

    def delete_droplet(self, ident):
        super().delete_droplet(ident)
        if not self.keep_attachment:
            for volume in self.cache_volumes.values():
                volume['droplet_ids'] = [n for n in volume['droplet_ids'] if n != int(ident)]


class WarmCloudTests(unittest.TestCase):
    write_state = CloudTests.write_state
    reap = CloudTests.reap

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = cloud.validate_config(warm_configuration(self.root))
        for path in (self.config['root'], self.config['repo'], self.config['volume']['mount_path']):
            Path(path).mkdir()
        Path(self.config['credentials']).write_text(json.dumps({'context':'personal','auth-contexts':{'personal':'dop_v1_FIXTURE_SECRET'}}))
        self.metadata = {'droplet_id': 99, 'hostname': 'fixture-cloud-control', 'region': 'mem1'}
        self.api = WarmAPI(self.config)

    def clone(self, attached=False, known=True):
        created = (START + dt.timedelta(seconds=2)).isoformat()
        volume = {'id': CACHE_VOLUME, 'name': 'fixture-cloud-node-001-cache', 'size_gigabytes': 200,
                  'region': {'slug': 'atl1'}, 'description': 'Atomic CI cache fixture-cloud ' + 'a' * 32,
                  'created_at': created, 'droplet_ids': [201] if attached else []}
        self.api.cache_volumes[CACHE_VOLUME] = volume
        entry = {'name': volume['name'], 'node_id':'node-001', 'account':'personal', 'expected_uuid':ACCOUNT,
                 'absence_verified':True, 'attempted_at':(START+dt.timedelta(seconds=1)).isoformat(),
                 'source_snapshot':copy.deepcopy(self.api.snapshots[SNAPSHOT]), 'description':volume['description']}
        if known:
            entry.update(id=CACHE_VOLUME, created_at=created)
        ledger = {volume['name']:entry}
        runtime = Path(self.config['fanout_config']['runtime_dir'])
        runtime.mkdir(parents=True, exist_ok=True)
        (runtime / 'warm-volumes.json').write_text(json.dumps(ledger))
        return entry

    def state(self, with_worker=False):
        nodes = {}
        if with_worker:
            node = CloudTests.worker(self)
            self.api.records[201]['region'] = {'slug':'atl1'}
            self.api.records[201]['volume_ids'] = [CACHE_VOLUME]
            nodes['node-001'] = node
        else:
            nodes['node-001'] = {'id':'node-001','account':'personal','name':'fixture-cloud-node-001'}
        self.write_state(nodes)
        return json.loads((Path(self.config['fanout_config']['runtime_dir'])/'state.json').read_text())

    def cleanup_clones(self, now=DEADLINE):
        state = json.loads((Path(self.config['fanout_config']['runtime_dir'])/'state.json').read_text())
        return cloud.reap_cache_volumes(self.config, self.api, state, now)

    def test_explicit_warm_mode_selects_the_public_snapshot_driver(self):
        self.assertEqual(cloud.fanout_driver(self.config),'ci-fanout-warm.py')
        self.assertEqual(cloud.fanout_driver({'cloud_worker_mode':'cold'}),'ci-fanout.py')
        self.assertEqual(cloud.fanout_driver({}),'ci-fanout.py')

    def test_expired_warm_bootstrap_does_not_contact_provider_or_install_anything(self):
        config=copy.deepcopy(self.config)
        config['campaign_started_at']=(START-dt.timedelta(hours=2)).isoformat()
        config['deadline']=(DEADLINE-dt.timedelta(hours=2)).isoformat()
        config['controller']['creation_intent_at']=config['campaign_started_at']
        config['fanout_config']['absolute_deadline']=config['deadline']
        with mock.patch.object(cloud.subprocess,'run',side_effect=AssertionError('expired campaign cannot install/start')):
            with self.assertRaises(TimeoutError):
                cloud.bootstrap_run(config,api=self.api,metadata=self.metadata)
        self.assertEqual(self.api.calls,[])
        self.assertEqual(self.api.deleted,[])

    def test_warm_regions_and_retained_vs_clone_prices_remain_separate(self):
        self.assertEqual(self.config['fanout_config']['region'], 'atl1')
        self.assertEqual(self.config['volume']['region'], 'mem1')
        self.assertEqual(self.config['expected_volume_hourly_rate'], .0015)
        self.assertEqual(self.config['expected_cache_volume_hourly_rate'], .03)
        self.assertEqual(self.config['fanout_config']['expected_volume_hourly_rate'], .03)
        self.assertEqual(cloud.verify_controller(self.config,self.api,self.metadata)['id'],99)
        self.assertEqual(cloud.verify_volume(self.config,self.api,99)['id'],VOLUME)

    def test_lost_create_response_is_reconciled_only_from_owned_clone_proof(self):
        self.state()
        self.clone(known=False)
        result = self.cleanup_clones()
        self.assertTrue(result['all_deleted'])
        self.assertEqual(result['cache_volume_ids_deleted'], [CACHE_VOLUME])
        self.assertGreater(result['estimated_storage_usd'],0)
        self.assertEqual(self.api.deleted, [('volume',CACHE_VOLUME)])
        self.assertEqual(self.api.volume_record['id'],VOLUME)
        self.assertIn(SNAPSHOT,self.api.snapshots)

    def test_known_volume_404_with_stale_listing_cannot_prove_absence(self):
        self.state()
        self.clone()
        self.api.stale_volume_404 = True
        result = self.cleanup_clones()
        self.assertFalse(result['all_deleted'])
        self.assertEqual(self.api.deleted,[])

    def test_recent_unknown_create_and_empty_provider_listing_keeps_cleanup_pending(self):
        self.state()
        entry=self.clone(known=False)
        self.api.cache_volumes.clear()
        entry['attempted_at']=(DEADLINE-dt.timedelta(seconds=30)).isoformat()
        path=Path(self.config['fanout_config']['runtime_dir'])/'warm-volumes.json'
        path.write_text(json.dumps({entry['name']:entry}))
        result=self.cleanup_clones()
        self.assertFalse(result['all_deleted'])
        self.assertEqual(self.api.deleted,[])

    def test_clone_identity_mutations_never_authorize_volume_deletion(self):
        mutations = [
            ('id', lambda e,v:e.update(id='55555555-5555-5555-5555-555555555555')),
            ('name', lambda e,v:v.update(name='foreign-cache')),
            ('account', lambda e,v:e.update(account='other')),
            ('uuid', lambda e,v:e.update(expected_uuid='55555555-5555-5555-5555-555555555555')),
            ('region', lambda e,v:v.update(region={'slug':'mem1'})),
            ('size', lambda e,v:v.update(size_gigabytes=10)),
            ('description', lambda e,v:v.update(description='foreign description')),
            ('snapshot', lambda e,v:e['source_snapshot'].update(id='foreign-snapshot')),
            ('actual-snapshot', lambda e,v:v.update(snapshot_id='foreign-snapshot')),
            ('actual-id', lambda e,v:v.update(id='55555555-5555-5555-5555-555555555555')),
            ('changed-created', lambda e,v:v.update(created_at=(START+dt.timedelta(seconds=3)).isoformat())),
            ('created', lambda e,v:v.update(created_at=(START-dt.timedelta(minutes=1)).isoformat())),
        ]
        for label, change in mutations:
            with self.subTest(label=label):
                self.api=WarmAPI(self.config)
                self.state()
                entry=self.clone()
                change(entry,self.api.cache_volumes[CACHE_VOLUME])
                path=Path(self.config['fanout_config']['runtime_dir'])/'warm-volumes.json'
                path.write_text(json.dumps({entry['name']:entry}))
                result=self.cleanup_clones()
                self.assertFalse(result['all_deleted'])
                self.assertEqual(self.api.deleted,[])

    def test_foreign_attachment_blocks_cache_and_controller_deletion(self):
        self.state(with_worker=True)
        self.clone(attached=True)
        self.api.cache_volumes[CACHE_VOLUME]['droplet_ids'].append(888)
        result=self.reap()
        self.assertFalse(result['cleanup_complete'])
        self.assertFalse(result['self_delete_requested'])
        self.assertNotIn(('volume',CACHE_VOLUME),self.api.deleted)
        self.assertNotIn(('droplet',99),self.api.deleted)

    def test_workers_are_removed_and_detached_before_clone_then_controller(self):
        self.state(with_worker=True)
        self.clone(attached=True)
        with mock.patch.object(cloud.subprocess,'run',side_effect=AssertionError('reaper cannot require doctl/git')):
            result=self.reap()
        self.assertTrue(result['cleanup_complete'])
        self.assertEqual(self.api.deleted[0],('droplet',201))
        self.assertLess(self.api.deleted.index(('volume',CACHE_VOLUME)), self.api.deleted.index(('droplet',99)))
        self.assertEqual(self.api.volume_record['id'],VOLUME)
        self.assertIn(SNAPSHOT,self.api.snapshots)

    def test_unconfirmed_volume_delete_blocks_controller_cleanup(self):
        self.state()
        self.clone()
        self.api.keep_volume_after_delete=True
        result=self.reap()
        self.assertFalse(result['cleanup_complete'])
        self.assertFalse(result['self_delete_requested'])
        self.assertNotIn(('droplet',99),self.api.deleted)

    def test_owned_volume_delete_response_loss_can_be_resolved_by_fresh_absence(self):
        self.state()
        self.clone()
        self.api.lose_volume_delete=True
        result=self.cleanup_clones()
        self.assertTrue(result['all_deleted'])
        self.assertEqual(self.api.deleted,[('volume',CACHE_VOLUME)])

    def test_bootstrap_failure_releases_workers_and_clone_before_deadline_without_bootstrap_tools(self):
        self.state(with_worker=True)
        self.clone(attached=True)
        (Path(self.config['root'])/'cloud-status.json').write_text('{"phase":"failed"}')
        with mock.patch.object(cloud.subprocess,'run',side_effect=AssertionError('cleanup cannot depend on bootstrap tools')):
            result=self.reap(now=NOW)
        self.assertTrue(result['cleanup_complete'])
        self.assertFalse(result['self_delete_requested'])
        self.assertIn(('droplet',201),self.api.deleted)
        self.assertIn(('volume',CACHE_VOLUME),self.api.deleted)
        self.assertNotIn(('droplet',99),self.api.deleted)

    def test_unrecorded_second_clone_keeps_controller_alive_after_first_clone_is_cleaned(self):
        self.state()
        self.clone()
        extra='55555555-5555-5555-5555-555555555555'
        self.api.cache_volumes[extra]=dict(self.api.cache_volumes[CACHE_VOLUME],id=extra,name='fixture-cloud-node-002-cache')
        result=self.reap()
        self.assertFalse(result['cleanup_complete'])
        self.assertIn(('volume',CACHE_VOLUME),self.api.deleted)
        self.assertNotIn(('volume',extra),self.api.deleted)
        self.assertNotIn(('droplet',99),self.api.deleted)

    def test_public_warm_controller_ledger_is_cleaned_by_independent_cloud_reaper(self):
        # Exercise the actual producer and consumer together. Only provider calls,
        # SSH preparation and the local key setup are fake; the ledger is not.
        case=self
        class PublicProvider(launch.BASE.DigitalOcean):
            def __init__(self):
                super().__init__('unused-selected-credentials')
            def raw(self, account, args):
                if args==['account','get']:
                    return {'uuid':ACCOUNT,'droplet_limit':10}
                if args==['compute','droplet','list']:
                    return case.api.droplets()
                if args==['compute','volume','list']:
                    return case.api.volumes()
                if args[:3]==['compute','snapshot','get']:
                    return case.api.snapshot(args[3])
                if args[:3]==['compute','volume','create']:
                    ledger=json.loads((Path(case.config['fanout_config']['runtime_dir'])/'warm-volumes.json').read_text())
                    intent=ledger[args[3]]
                    case.assertTrue(intent['absence_verified'])
                    case.assertEqual(intent['expected_uuid'],ACCOUNT)
                    case.assertNotIn('id',intent)
                    case.assertEqual(args[args.index('--snapshot')+1],SNAPSHOT)
                    volume={'id':CACHE_VOLUME,'name':args[3],'size_gigabytes':200,'region':{'slug':'atl1'},
                            'description':args[args.index('--desc')+1], 'created_at':launch.BASE.stamp(),'droplet_ids':[]}
                    case.api.cache_volumes[CACHE_VOLUME]=volume
                    return [copy.deepcopy(volume)]
                if args[:3]==['compute','droplet','create']:
                    volume=case.api.cache_volumes[args[args.index('--volumes')+1]]
                    volume['droplet_ids']=[201]
                    record={'id':201,'name':args[3],'created_at':launch.BASE.stamp(),
                            'size_slug':case.config['fanout_config']['size'],'size':{'price_hourly':1.5},
                            'region':{'slug':'atl1'},'volume_ids':[volume['id']]}
                    case.api.records[201]=record
                    return [copy.deepcopy(record)]
                raise AssertionError('unexpected public provider call: '+repr(args))
        provider=PublicProvider()
        public=launch.WARM.controller_class(launch.BASE,lambda _:provider)(self.config['fanout_config'])
        public.prepare=lambda key:public.node_update(key,status='ready')
        public.event=lambda value:None
        with mock.patch.object(launch.BASE,'execute',return_value=''):
            public.initialize({'dagger_version':'0.0.1','nodes':3})
        public.update(lambda state:state.update(keys={'personal':{'id':124}}))
        public.create('node-001')
        ledger=json.loads((public.root/'warm-volumes.json').read_text())
        self.assertEqual(ledger['fixture-cloud-node-001-cache']['id'],CACHE_VOLUME)
        # The fixture did not import a worker key; do not invent ownership of one.
        public.update(lambda state:state.update(keys={}))
        result=self.reap()
        self.assertTrue(result['cleanup_complete'])
        self.assertEqual(self.api.deleted[0],('droplet',201))
        self.assertIn(('volume',CACHE_VOLUME),self.api.deleted)
        self.assertEqual(self.api.deleted[-1],('droplet',99))
        self.assertIn(SNAPSHOT,self.api.snapshots)
        self.assertEqual(self.api.volume_record['id'],VOLUME)

    def test_warm_ledger_and_startup_proof_are_persisted_without_credentials(self):
        self.state()
        self.clone()
        runtime=Path(self.config['fanout_config']['runtime_dir'])
        (runtime/'warm-cleanup.json').write_text('{"all_deleted":true}')
        proof=runtime/'node-001/cache-startup.json'
        proof.parent.mkdir(parents=True, exist_ok=True)
        proof.write_text('{"restoration_verified":true}')
        with mock.patch.object(cloud,'verify_mount',return_value=Path(self.config['volume']['mount_path'])):
            receipt=cloud.persist_evidence(self.config,final=True)
        saved=Path(self.config['volume']['mount_path'])/'runs/fixture-cloud/runtime'
        self.assertTrue((saved/'warm-volumes.json').is_file())
        self.assertTrue((saved/'warm-cleanup.json').is_file())
        self.assertEqual((saved/'node-001/cache-startup.json').read_text(),proof.read_text())
        self.assertNotIn('dop_v1_FIXTURE_SECRET',json.dumps(receipt))


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
                     'regions': [self.config['region']], 'price_hourly': 1.5},
                    {'slug': self.config['cloud_controller_size'], 'vcpus': 2, 'available': True,
                     'regions': [self.config.get('cloud_controller_region', self.config['region'])], 'price_hourly': .04}]
        if args[:3] == ['compute', 'snapshot', 'get']:
            return [{'id':SNAPSHOT,'name':'reviewed-seed','resource_type':'volume','resource_id':'seed-volume','regions':['atl1'],'min_disk_size':200}]
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

    def test_explicit_reuse_allows_unknown_api_filesystem_without_creating_resources(self):
        for filesystem in ('', None):
            with self.subTest(filesystem=filesystem):
                self.api.volumes = [{'id': VOLUME, 'name': 'fixture-cache', 'size_gigabytes': 10,
                                     'region': {'slug': 'mem1'}, 'filesystem_type': filesystem, 'droplet_ids': []}]
                controller = launch.CloudLauncher(dict(self.config, cloud_volume_id=VOLUME), api=self.api,
                                                  run=self.run_command, now=lambda: NOW)
                with self.source_plan(), mock.patch.object(launch.BASE.Controller, 'plan', return_value=self.worker_plan):
                    controller.plan()
                self.assertEqual(self.api.creates, [])
                self.assertFalse(Path(self.config['runtime_dir']).exists())

    def test_reuse_rejects_known_wrong_filesystem_and_new_volume_requires_ext4(self):
        record = {'id': VOLUME, 'name': 'fixture-cache', 'size_gigabytes': 10,
                  'region': {'slug': 'mem1'}, 'droplet_ids': []}
        reused = launch.CloudLauncher(dict(self.config, cloud_volume_id=VOLUME), api=self.api,
                                      run=self.run_command, now=lambda: NOW)
        for filesystem in ('xfs', 'btrfs', 'unknown'):
            with self.subTest(reused_filesystem=filesystem), self.assertRaises(ValueError):
                reused.check_volume(dict(record, filesystem_type=filesystem), reused=True)
        for filesystem in ('', None, 'xfs'):
            with self.subTest(new_filesystem=filesystem), self.assertRaises(ValueError):
                self.controller.check_volume(dict(record, filesystem_type=filesystem), reused=False)
        self.controller.check_volume(dict(record, filesystem_type='ext4'), reused=False)
        self.assertEqual(self.api.creates, [])

    def test_oversized_userdata_is_rejected_before_any_paid_create(self):
        payload = b''.join(hashlib.sha512(str(index).encode()).digest() for index in range(2048))
        scripts = dict(self.scripts, **{'ci-fanout-cloud.py': self.scripts['ci-fanout-cloud.py'] + b'\n# ' + base64.b64encode(payload)})
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
        files = {}
        for entry in data['write_files']:
            payload = base64.b64decode(entry['content'])
            if entry['encoding'] == 'gz+b64':
                payload = gzip.decompress(payload)
            else:
                self.assertEqual(entry['encoding'], 'b64')
            files[entry['path']] = payload.decode()
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


class WarmLauncherTests(unittest.TestCase):
    run_command = LauncherTests.run_command
    source_plan = LauncherTests.source_plan

    def setUp(self):
        LauncherTests.setUp(self)
        warm=warm_configuration(self.root)
        self.config.update(cloud_worker_mode='warm', cloud_controller_region='mem1', region='atl1',
                           cloud_volume_id=VOLUME, expected_cache_volume_hourly_rate=.03,
                           cache_namespace='fixturewarm', source_snapshots=warm['fanout_config']['source_snapshots'])
        self.scripts['ci-fanout-warm.py']=Path(launch.WARM.__file__).read_bytes()
        self.worker_plan.update(nodes=3, hourly_usd=4.5, dagger_version='0.0.1')
        self.api=LauncherAPI(self.config)
        self.api.volumes=[{'id':VOLUME,'name':'fixture-cache','size_gigabytes':10,
                           'region':{'slug':'mem1'},'filesystem_type':'ext4','droplet_ids':[],'created_at':START.isoformat()}]
        self.controller=launch.CloudLauncher(self.config,api=self.api,run=self.run_command,now=lambda:NOW)

    def test_warm_readonly_plan_checks_snapshot_and_counts_all_three_clone_disks(self):
        with self.source_plan(), mock.patch.object(launch.BASE.Controller,'plan',return_value=self.worker_plan):
            plan=self.controller.plan()
        self.assertEqual(plan['cloud_worker_mode'],'warm')
        self.assertEqual(plan['region'],'atl1')
        self.assertEqual(plan['controller_region'],'mem1')
        self.assertEqual(plan['cache_volume_gib'],200)
        self.assertAlmostEqual(plan['cache_storage_hourly_usd_estimate'],.09)
        self.assertAlmostEqual(plan['hourly_usd'],4.6315)
        self.assertAlmostEqual(plan['maximum_estimated_usd'],4.6315*(1+120/3600)+.15)
        self.assertTrue(any(args[:3]==['compute','snapshot','get'] for args in self.api.calls))
        self.assertEqual(self.api.creates,[])
        self.assertFalse(Path(self.config['runtime_dir']).exists())

    def test_warm_snapshot_companion_and_reuse_guards_run_before_any_paid_create(self):
        mutations=[
            lambda c:c.update(cloud_worker_mode='typo'),
            lambda c:c.pop('cloud_volume_id'),
            lambda c:c.update(expected_cache_volume_hourly_rate=float('nan')),
            lambda c:c['source_snapshots']['personal'].pop('dagger_engine_version'),
            lambda c:c['source_snapshots']['personal'].update(cache_namespace='wrong-cache'),
            lambda c:c['source_snapshots']['personal'].update(dagger_engine_version='0.0.2'),
            lambda c:c['source_snapshots']['personal'].update(architecture='linux/arm64'),
            lambda c:c['source_snapshots']['personal'].update(docker_data_root='/wrong-root'),
        ]
        labels=('mode','retained-id','price','missing-engine','namespace','engine-version','architecture','data-root')
        for index, change in enumerate(mutations):
            with self.subTest(guard=labels[index]):
                config=copy.deepcopy(self.config)
                change(config)
                config['runtime_dir']=str(self.root/('rejected-'+str(index)))
                api=LauncherAPI(config)
                api.volumes=copy.deepcopy(self.api.volumes)
                with self.source_plan(), mock.patch.object(launch.BASE.Controller,'plan',return_value=self.worker_plan), self.assertRaises(ValueError):
                    controller=launch.CloudLauncher(config,api=api,run=self.run_command,now=lambda:NOW)
                    controller.launch()
                self.assertEqual(api.creates,[])
                self.assertFalse(Path(config['runtime_dir']).exists())

    def test_snapshot_worker_region_and_retained_controller_region_are_both_checked(self):
        for target in ('worker','controller'):
            with self.subTest(target=target):
                config=copy.deepcopy(self.config)
                if target=='worker':
                    config['region']='wrong-region'
                else:
                    config['cloud_controller_region']='wrong-region'
                with self.source_plan(), mock.patch.object(launch.BASE.Controller,'plan',return_value=self.worker_plan), self.assertRaises(ValueError):
                    launch.CloudLauncher(config,api=self.api,run=self.run_command,now=lambda:NOW).launch()
                self.assertEqual(self.api.creates,[])

    def test_remote_contract_remaps_only_worker_clone_rate_and_keeps_control_region(self):
        state={'campaign_started_at':START.isoformat(),'deadline':DEADLINE.isoformat(),
               'controller':self.configured_controller(),
               'ssh_key':{'id':123,'name':'fixture-cloud-controller-key','fingerprint':'aa:bb'},
               'volume':{'id':VOLUME,'name':'fixture-cache'}}
        remote=self.controller.remote_config(state)
        normalized=cloud.validate_config(remote)
        self.assertEqual(normalized['cloud_worker_mode'],'warm')
        self.assertEqual(normalized['volume']['region'],'mem1')
        self.assertEqual(normalized['fanout_config']['region'],'atl1')
        self.assertEqual(normalized['expected_volume_hourly_rate'],.0015)
        self.assertEqual(normalized['expected_cache_volume_hourly_rate'],.03)
        self.assertEqual(normalized['fanout_config']['expected_volume_hourly_rate'],.03)
        self.assertEqual(self.controller.config['expected_volume_hourly_rate'],.0015)

    def configured_controller(self):
        return {'name':'fixture-cloud-controller','ownership_tag':'fixture-owned',
                'intent_at':START.isoformat(),'creation_intent_at':START.isoformat()}

    def test_budget_that_fits_cold_workers_cannot_silently_omit_clone_storage(self):
        config=dict(self.config,max_total_usd=4.88)
        with self.source_plan(), mock.patch.object(launch.BASE.Controller,'plan',return_value=self.worker_plan), self.assertRaisesRegex(ValueError,'budget'):
            launch.CloudLauncher(config,api=self.api,run=self.run_command,now=lambda:NOW).launch()
        self.assertEqual(self.api.creates,[])

    def test_cold_mode_refuses_accidentally_ignored_snapshot_or_clone_price_settings(self):
        cold=copy.deepcopy(self.config)
        for field in ('cloud_worker_mode','source_snapshots','expected_cache_volume_hourly_rate'):
            cold.pop(field,None)
        cold.update(region='mem1',cloud_controller_region='mem1')
        # Each rejected input is the only warm-only setting present.
        for changes in ({'cloud_worker_mode':'unknown'}, {'expected_cache_volume_hourly_rate':.03},
                        {'source_snapshots':self.config['source_snapshots']},
                        {'source_snapshot_profile':{'cache_namespace':'fixturewarm'}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                launch.CloudLauncher(dict(cold,**changes),api=self.api,run=self.run_command,now=lambda:NOW)
        self.assertEqual(self.api.creates,[])


if __name__ == '__main__':
    unittest.main()
