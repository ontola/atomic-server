#!/usr/bin/env python3
"""Warm-cache ownership/lifecycle regressions; all provider effects are fake."""
from __future__ import annotations

import copy
import datetime as dt
import importlib.util
import json
import shlex
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
from unittest import mock

sys.dont_write_bytecode = True

SPEC = importlib.util.spec_from_file_location('fanout_warm', Path(__file__).with_name('ci-fanout-warm.py'))
warm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(warm)
base = warm.load_controller()
SHA = 'a' * 40
UUIDS = {'alpha': '11111111-1111-1111-1111-111111111111',
         'beta': '22222222-2222-2222-2222-222222222222'}


def configuration(root):
    return warm.validate_config({
        'batch_key': 'fixture-warm', 'test_run_key': 'fixture-warm', 'cache_namespace': 'fixturewarm',
        'source_commit': SHA, 'worktree': str(root / 'repo'),
        'runtime_dir': str(root / 'runtime'), 'doctl_config': str(root / 'credentials'),
        'region': 'fixture-region', 'size': 'fixture-size', 'max_hours': 1,
        'expected_hourly_rate': .5, 'expected_volume_hourly_rate': .02,
        'max_total_usd': 1.04, 'authorization': 'Run the reviewed two-node fixture for at most one hour.',
        'accounts': [{'context': context, 'expected_uuid': identity, 'nodes': 1}
                     for context, identity in UUIDS.items()],
        'source_snapshots': {context: {'id': 'snapshot-' + context, 'name': 'reviewed-' + context,
                                     'cache_namespace': 'fixturewarm', 'dagger_engine_version': '0.0.1',
                                     'architecture': 'linux/amd64', 'docker_data_root': '/mnt/atomic-ci/docker'}
                             for context in UUIDS},
    }, base)


class FakeAPI(base.DigitalOcean):
    def __init__(self, config):
        super().__init__('unused')
        self.config = config
        self.calls = []
        self.mutations = []
        self.identities = dict(UUIDS)
        self.volumes = {context: [] for context in UUIDS}
        self.droplets = {context: [] for context in UUIDS}
        self.snapshots = {context: {
            'id': 'snapshot-' + context, 'name': 'reviewed-' + context,
            'resource_type': 'volume', 'resource_id': 'original-volume-' + context,
            'regions': ['fixture-region'], 'min_disk_size': 200,
        } for context in UUIDS}
        self.next_id = 100
        self.lose_create = False
        self.suppress_create = False
        self.wrong_create_identity = False
        self.lose_delete = False
        self.stale_delete_listing = False
        self.reported_hourly_rate = .5
        self.before_raw = None
        self.after_volume_create = None
        self.lose_vm_create = False
        self.hide_vm_lists = False

    def raw(self, account, args):
        context = account['context']
        self.calls.append((context, list(args)))
        if self.before_raw:
            self.before_raw(account, args)
        if args == ['account', 'get']:
            return {'uuid': self.identities[context], 'droplet_limit': 128}
        if args[:3] == ['compute', 'snapshot', 'get']:
            return copy.deepcopy(self.snapshots[context])
        if args == ['compute', 'size', 'list']:
            return [{'slug': 'fixture-size', 'available': True, 'regions': ['fixture-region'], 'price_hourly': self.reported_hourly_rate}]
        if args == ['compute', 'volume', 'list']:
            return copy.deepcopy(self.volumes[context])
        if args == ['compute', 'droplet', 'list']:
            return [] if self.hide_vm_lists else copy.deepcopy(self.droplets[context])
        if args[:3] == ['compute', 'volume', 'create']:
            # Every paid attempt must already have a durable ownership record.
            ledger = json.loads((Path(self.config['runtime_dir']) / 'warm-volumes.json').read_text())
            entry = ledger[args[3]]
            assert entry['absence_verified'] and entry['expected_uuid'] == UUIDS[context]
            assert not entry.get('id')
            assert '--region' not in args and '--fs-type' not in args
            assert args[args.index('--snapshot') + 1] == self.snapshots[context]['id']
            self.mutations.append((context, list(args)))
            self.next_id += 1
            volume = {'id': 'volume-' + str(self.next_id), 'name': args[3],
                      'region': {'slug': 'fixture-region'}, 'size_gigabytes': 200,
                      'created_at': base.stamp(), 'droplet_ids': [],
                      'description': args[args.index('--desc') + 1]}
            if not self.suppress_create:
                self.volumes[context].append(volume)
            if self.lose_create:
                raise TimeoutError('lost create response')
            value = copy.deepcopy(volume)
            if self.wrong_create_identity:
                value['name'] = 'foreign-name'
            if self.after_volume_create:
                self.after_volume_create()
            return [value]
        if args[:3] == ['compute', 'droplet', 'create']:
            self.mutations.append((context, list(args)))
            self.next_id += 1
            ident = self.next_id
            attached = args[args.index('--volumes') + 1]
            volume = next(volume for volume in self.volumes[context] if volume['id'] == attached)
            volume['droplet_ids'] = [ident]
            value = {'id': ident, 'name': args[3], 'size_slug': 'fixture-size',
                     'size': {'price_hourly': .5}, 'created_at': base.stamp()}
            self.droplets[context].append(value)
            if self.lose_vm_create:
                raise TimeoutError('lost VM create response')
            return [value]
        if args[:3] == ['compute', 'droplet', 'delete']:
            self.mutations.append((context, list(args)))
            self.droplets[context] = [item for item in self.droplets[context] if str(item['id']) != args[3]]
            for volume in self.volumes[context]:
                volume['droplet_ids'] = [ident for ident in volume['droplet_ids'] if str(ident) != args[3]]
            return None
        if args[:3] == ['compute', 'volume', 'delete']:
            self.mutations.append((context, list(args)))
            if not self.stale_delete_listing:
                self.volumes[context] = [volume for volume in self.volumes[context] if volume['id'] != args[3]]
            if self.lose_delete:
                raise TimeoutError('lost delete response')
            return None
        raise AssertionError('unexpected fake provider call: ' + repr(args))


class WarmTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = configuration(self.root)
        (self.root / 'credentials').write_text('fixture only; no real token')
        self.api = FakeAPI(self.config)
        cls = warm.controller_class(base, lambda path: self.api)
        self.controller = cls(self.config)
        self.controller.prepare = lambda key: self.controller.node_update(key, status='ready')
        self.controller.event = lambda value: None
        with mock.patch.object(base, 'execute', return_value=''):
            self.controller.initialize({'dagger_version': '0.0.1', 'nodes': 2})
        self.controller.update(lambda state: state.update(keys={context: {'id': index + 1}
                                                               for index, context in enumerate(UUIDS)}))

    def create(self, key='node-001'):
        self.controller.create(key)
        return self.controller.read()['nodes'][key]

    def cleanup(self):
        return warm.cleanup_volumes(self.config, base, self.api)

    def git_output(self, args, **kwargs):
        if args == ['git', 'rev-parse', 'HEAD']:
            return SHA + '\n'
        if args[:2] == ['git', 'status']:
            return ''
        if args[:2] == ['git', 'show']:
            return '{"engineVersion":"v0.0.1"}'
        raise AssertionError('unexpected local command: ' + repr(args))

    def test_inherits_scheduler_and_fresh_test_policy_without_overriding_run(self):
        self.assertIs(type(self.controller).run, base.Controller.run)
        self.assertIs(type(self.controller).run_check_worker, base.Controller.run_check_worker)
        self.assertIs(type(self.controller).finish_validation, base.Controller.finish_validation)

    def test_clone_is_recorded_before_create_attached_and_deleted_only_after_vm(self):
        node = self.create()
        ledger = json.loads((self.controller.root / 'warm-volumes.json').read_text())
        entry = ledger[node['name'] + '-cache']
        self.assertEqual(entry['account'], 'alpha')
        self.assertEqual(entry['source_snapshot']['id'], 'snapshot-alpha')
        self.assertFalse(self.cleanup())
        self.assertFalse(any(args[:3] == ['compute', 'volume', 'delete'] for _, args in self.api.mutations))
        self.controller.remove('node-001')
        self.assertTrue(self.cleanup())
        self.assertEqual(self.api.volumes['alpha'], [])
        mutations = list(self.api.mutations)
        self.assertTrue(self.cleanup())
        self.assertEqual(self.api.mutations, mutations)
        result = json.loads((self.controller.root / 'warm-cleanup.json').read_text())
        self.assertTrue(result['all_deleted'])
        self.assertGreater(result['estimated_storage_usd'], 0)
        self.assertFalse(any(args[:2] == ['compute', 'snapshot'] for _, args in self.api.mutations))

    def test_multiple_accounts_get_their_own_snapshot_and_ownership_guards(self):
        self.create('node-001')
        self.create('node-002')
        for key in ('node-001', 'node-002'):
            self.controller.remove(key)
        self.assertTrue(self.cleanup())
        self.assertEqual(self.api.volumes, {'alpha': [], 'beta': []})
        clones = [(context, args[args.index('--snapshot') + 1]) for context, args in self.api.mutations
                  if args[:3] == ['compute', 'volume', 'create']]
        self.assertEqual(clones, [('alpha', 'snapshot-alpha'), ('beta', 'snapshot-beta')])

    def test_preexisting_same_name_volume_is_never_adopted(self):
        name = self.controller.read()['nodes']['node-001']['name'] + '-cache'
        self.api.volumes['alpha'].append({'id': 'foreign', 'name': name})
        with self.assertRaisesRegex(ValueError, 'pre-existing'):
            self.create()
        self.assertFalse((self.controller.root / 'warm-volumes.json').exists())
        self.assertEqual(self.api.mutations, [])
        self.assertTrue(self.cleanup())
        self.assertEqual(self.api.volumes['alpha'][0]['id'], 'foreign')

    def test_lost_create_response_reconciles_owned_volume_without_creating_again(self):
        self.api.lose_create = True
        with self.assertRaisesRegex(TimeoutError, 'lost create'):
            self.create()
        with self.assertRaisesRegex(ValueError, 'already attempted'):
            self.create()
        self.assertTrue(self.cleanup())
        creates = [args for _, args in self.api.mutations if args[:3] == ['compute', 'volume', 'create']]
        self.assertEqual(len(creates), 1)
        self.assertEqual(self.api.volumes['alpha'], [])

    def test_unknown_create_absence_is_not_declared_safe_immediately(self):
        self.api.lose_create = self.api.suppress_create = True
        with self.assertRaises(TimeoutError):
            self.create()
        self.assertFalse(self.cleanup())
        now = base.utcnow()
        with mock.patch.object(base, 'utcnow', return_value=now + dt.timedelta(seconds=121)):
            self.assertTrue(self.cleanup())

    def test_foreign_replacement_and_attached_volume_are_preserved(self):
        self.create()
        original = copy.deepcopy(self.api.volumes['alpha'][0])
        self.controller.remove('node-001')
        for field, value in [('id', 'other-id'), ('description', 'foreign owner'),
                             ('created_at', '2001-01-01T00:00:00Z'), ('droplet_ids', [999])]:
            self.api.volumes['alpha'][0] = dict(original, droplet_ids=[], **{field: value}) if field != 'droplet_ids' else dict(original, droplet_ids=value)
            with self.subTest(field=field):
                self.assertFalse(self.cleanup())
                self.assertFalse(any(args[:3] == ['compute', 'volume', 'delete'] for _, args in self.api.mutations))
        self.api.volumes['alpha'][0] = dict(original, droplet_ids=[])
        self.assertTrue(self.cleanup())

    def test_inconsistent_creation_response_does_not_become_verified_cleanup(self):
        self.api.wrong_create_identity = True
        with self.assertRaisesRegex(ValueError, 'created volume identity'):
            self.create()
        self.assertFalse(self.cleanup())
        self.assertFalse(json.loads((self.controller.root / 'warm-cleanup.json').read_text())['all_deleted'])

    def test_lost_delete_response_can_still_verify_absence(self):
        self.create()
        self.controller.remove('node-001')
        self.api.lose_delete = True
        self.assertTrue(self.cleanup())

    def test_stale_delete_listing_is_reconciled_without_repeated_mutations(self):
        self.create()
        self.controller.remove('node-001')
        self.api.stale_delete_listing = True
        self.assertFalse(self.cleanup())
        self.assertFalse(self.cleanup())
        deletes = [args for _, args in self.api.mutations if args[:3] == ['compute', 'volume', 'delete']]
        self.assertEqual(len(deletes), 1)
        self.api.volumes['alpha'].clear()
        self.assertTrue(self.cleanup())

    def test_account_identity_change_blocks_clone_and_cleanup_mutations(self):
        self.api.identities['alpha'] = UUIDS['beta']
        with self.assertRaisesRegex(RuntimeError, 'UUID differs'):
            self.create()
        self.assertEqual(self.api.mutations, [])
        self.api.identities['alpha'] = UUIDS['alpha']
        self.create()
        self.controller.remove('node-001')
        self.api.identities['alpha'] = UUIDS['beta']
        before = list(self.api.mutations)
        self.assertFalse(self.cleanup())
        self.assertEqual(self.api.mutations, before)

    def test_deadline_blocks_all_clone_creation_and_cannot_be_reset(self):
        self.controller.update(lambda state: state.update(deadline=(base.utcnow() - dt.timedelta(seconds=1)).isoformat()))
        with self.assertRaises(TimeoutError):
            self.create()
        self.assertEqual(self.api.mutations, [])
        with self.assertRaisesRegex(ValueError, 'State already exists'):
            self.controller.initialize({'dagger_version': '0.0.1'})
        changed = dict(self.config, max_hours=2, max_total_usd=3)
        with self.assertRaisesRegex(ValueError, 'immutable batch state'):
            warm.controller_class(base, lambda path: self.api)(changed)

    def test_slow_snapshot_and_volume_reads_cannot_start_a_paid_clone_after_deadline(self):
        for operation in ('snapshot', 'volume-list'):
            self.controller.update(lambda state: state.update(
                deadline=(base.utcnow() + dt.timedelta(minutes=1)).isoformat(), stop_requested=False))
            def expire(account, args):
                selected = (args[:3] == ['compute', 'snapshot', 'get'] if operation == 'snapshot'
                            else args == ['compute', 'volume', 'list'])
                if selected:
                    self.controller.update(lambda state: state.update(
                        deadline=(base.utcnow() - dt.timedelta(seconds=1)).isoformat()))
            self.api.before_raw = expire
            with self.subTest(operation=operation), self.assertRaises(TimeoutError):
                self.create('node-001' if operation == 'snapshot' else 'node-002')
            self.assertEqual(self.api.mutations, [])
            self.assertFalse((self.controller.root / 'warm-volumes.json').exists())

    def test_stop_during_provider_reads_prevents_paid_creation(self):
        def stop(account, args):
            if args == ['compute', 'volume', 'list']:
                self.controller.update(lambda state: state.update(stop_requested=True))
        self.api.before_raw = stop
        with self.assertRaises(TimeoutError):
            self.create()
        self.assertEqual(self.api.mutations, [])

    def test_final_identity_check_cannot_consume_budget_and_then_start_clone(self):
        def expire(account, args):
            checks = sum(1 for _, call in self.api.calls if call == ['account', 'get'])
            if args == ['account', 'get'] and checks == 3:
                self.controller.update(lambda state: state.update(
                    deadline=(base.utcnow() - dt.timedelta(seconds=1)).isoformat()))
        self.api.before_raw = expire
        with self.assertRaises(TimeoutError):
            self.create()
        self.assertEqual(self.api.mutations, [])

    def test_slow_clone_or_stop_response_leaves_owned_volume_cleanable_without_starting_vm(self):
        for change in ('deadline', 'stop'):
            with self.subTest(change=change):
                self.controller.update(lambda state: state.update(
                    deadline=(base.utcnow() + dt.timedelta(minutes=1)).isoformat(), stop_requested=False))
                self.api.after_volume_create = lambda: self.controller.update(
                    lambda state: state.update(**({'stop_requested': True} if change == 'stop' else
                                                  {'deadline': (base.utcnow() - dt.timedelta(seconds=1)).isoformat()})))
                with self.assertRaises(TimeoutError):
                    self.create('node-001' if change == 'deadline' else 'node-002')
                self.assertFalse(any(args[:3] == ['compute', 'droplet', 'create'] for _, args in self.api.mutations))
                ledger = json.loads((self.controller.root / 'warm-volumes.json').read_text())
                self.assertTrue(all(entry.get('id') for entry in ledger.values()))
                self.assertTrue(self.cleanup())

    def test_account_identity_is_checked_again_after_clone_before_vm_creation(self):
        self.api.after_volume_create = lambda: self.api.identities.update(alpha=UUIDS['beta'])
        with self.assertRaisesRegex(RuntimeError, 'UUID differs'):
            self.create()
        self.assertFalse(any(args[:3] == ['compute', 'droplet', 'create'] for _, args in self.api.mutations))
        self.api.identities['alpha'] = UUIDS['alpha']
        self.assertTrue(self.cleanup())

    def test_volume_reconciliation_grace_starts_after_slow_final_identity_lookup(self):
        clock = [base.utcnow()]
        def slow_identity(account, args):
            checks = sum(1 for _, call in self.api.calls if call == ['account', 'get'])
            if args == ['account', 'get'] and checks == 3:
                clock[0] += dt.timedelta(seconds=130)
        self.api.before_raw = slow_identity
        self.api.lose_create = self.api.suppress_create = True
        with mock.patch.object(base, 'utcnow', side_effect=lambda: clock[0]):
            with self.assertRaisesRegex(TimeoutError, 'lost create response'):
                self.create()
            ledger = json.loads((self.controller.root / 'warm-volumes.json').read_text())
            entry = next(iter(ledger.values()))
            self.assertEqual(warm.timestamp(entry['attempted_at']), clock[0])
            self.assertFalse(self.cleanup())
            clock[0] += dt.timedelta(seconds=121)
            self.assertTrue(self.cleanup())

    def test_mount_bootstrap_preserves_snapshot_and_requires_mounted_ext4_for_docker(self):
        text = self.controller.cloud_init('0.0.1')
        commands = [json.loads(line[4:]) for line in text.splitlines() if line.startswith('  - ["bash"')]
        script = commands[0][-1]
        for expected in ('blkid -s TYPE', '= ext4', 'mountpoint -q /mnt/atomic-ci',
                         'RequiresMountsFor=/mnt/atomic-ci', '/etc/fstab',
                         '"data-root":"/mnt/atomic-ci/docker"', '/mnt/atomic-ci/browser-bundles'):
            self.assertIn(expected, script)
        self.assertNotIn('mkfs', script)
        subprocess.run(['bash', '-n'], input=script, text=True, check=True)
        self.assertLess(script.index('systemctl stop docker'), script.index('mount "$1"'))
        self.assertLess(script.index('mountpoint -q'), script.index('systemctl enable --now docker'))
        with mock.patch.object(base.Controller, 'cloud_init', return_value='changed upstream bootstrap'):
            with self.assertRaisesRegex(ValueError, 'changed base Docker'):
                self.controller.cloud_init('0.0.1')

    def test_snapshot_type_name_region_and_minimum_are_checked_before_cloning(self):
        original = copy.deepcopy(self.api.snapshots['alpha'])
        for field, value in [('id', 'wrong-id'), ('name', 'renamed'), ('resource_type', 'droplet'),
                             ('regions', ['other-region']), ('min_disk_size', 201)]:
            self.api.snapshots['alpha'] = dict(original, **{field: value})
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'source snapshot identity'):
                warm.verify_snapshot(self.api, self.controller.account('alpha'), self.config)
            self.assertEqual(self.api.mutations, [])

    def late_vm_cleanup(self, lose_response):
        clock = [base.utcnow()]
        original_snapshots = copy.deepcopy(self.api.snapshots)
        self.api.lose_vm_create = lose_response
        self.api.hide_vm_lists = True
        self.api.after_volume_create = lambda: clock.__setitem__(0, clock[0] + dt.timedelta(seconds=130))
        with mock.patch.object(base, 'utcnow', side_effect=lambda: clock[0]):
            if lose_response:
                with self.assertRaisesRegex(TimeoutError, 'lost VM create response'):
                    self.create()
            else:
                self.create()
            node = self.controller.read()['nodes']['node-001']
            self.assertEqual(warm.timestamp(node['creation_attempted_at']), clock[0])
            self.assertTrue(node['creation_absence_verified'])
            self.assertEqual(node['creation_account_uuid'], UUIDS['alpha'])
            self.assertEqual(len(self.api.droplets['alpha']), 1)
            # The fixture uses placeholder key IDs only for VM scheduling;
            # there are no imported keys to reconcile in this fake provider.
            self.controller.update(lambda state: state.update(keys={}))
            with self.assertRaisesRegex(RuntimeError, 'pending provider reconciliation'):
                self.controller.cleanup('late VM response fixture')
            state = self.controller.read()
            self.assertEqual(state['status'], 'cleanup_failed')
            self.assertIsNone(state['finished_at'])
            self.assertFalse(self.cleanup())  # Volume is attached to the hidden VM.
            self.assertEqual(len(self.api.volumes['alpha']), 1)
            self.api.hide_vm_lists = False
            clock[0] += dt.timedelta(seconds=5)
            # Exercise the actual public VM/key watchdog; no mocked cleanup.
            self.assertTrue(self.controller.watchdog_step())
            self.assertEqual(self.api.droplets['alpha'], [])
            self.assertTrue(self.controller.read()['nodes']['node-001']['deletion_verified'])
            warm.write_json(self.controller.root / 'warm-started.json', {'pid': 999999, 'at': base.stamp()})
            with mock.patch.object(base, 'DigitalOcean', return_value=self.api):
                self.assertTrue(warm.watchdog_step(self.config, base, alive=lambda pid: False))
            self.assertEqual(self.api.volumes['alpha'], [])
            self.assertEqual(self.api.snapshots, original_snapshots)

    def test_lost_slow_vm_create_stays_pending_until_public_watchdog_finds_and_removes_it(self):
        self.late_vm_cleanup(lose_response=True)

    def test_known_slow_vm_create_with_hidden_list_is_not_prematurely_marked_deleted(self):
        self.late_vm_cleanup(lose_response=False)

    def test_readonly_plan_reports_snapshot_and_full_budget(self):
        with mock.patch.object(base, 'execute', side_effect=self.git_output):
            plan = self.controller.plan()
        self.assertEqual(plan['maximum_compute_and_storage_usd'], 1.04)
        self.assertEqual(set(plan['source_snapshots']), {'alpha', 'beta'})
        self.assertEqual(self.api.mutations, [])

    def test_readonly_plan_rejects_changed_provider_compute_price(self):
        self.api.reported_hourly_rate = .9
        with mock.patch.object(base, 'execute', side_effect=self.git_output):
            with self.assertRaisesRegex(RuntimeError, 'Hourly price differs'):
                self.controller.plan()
        self.assertEqual(self.api.mutations, [])

    def test_snapshot_id_name_shorthand_cannot_bypass_required_cache_companion(self):
        settings = dict(self.config)
        settings['accounts'] = [dict(self.config['accounts'][0], nodes=2)]
        del settings['source_snapshots']
        settings.update(source_snapshot_id='snapshot-alpha', source_snapshot_name='reviewed-alpha')
        with self.assertRaisesRegex(ValueError, 'snapshot cache'):
            warm.validate_config(settings, base)

    def test_single_account_shorthand_requires_an_explicit_cache_companion(self):
        settings=copy.deepcopy(self.config)
        settings['accounts']=[dict(settings['accounts'][0],nodes=2)]
        profile=settings.pop('source_snapshots')['alpha']
        settings.update(source_snapshot_id=profile['id'],source_snapshot_name=profile['name'],
                        source_snapshot_profile={key:profile[key] for key in
                            ('cache_namespace','dagger_engine_version','architecture','docker_data_root')})
        result=warm.validate_config(settings,base)
        self.assertEqual(result['source_snapshots']['alpha'],profile)

    def test_no_state_watchdog_exits_only_when_its_owner_is_gone(self):
        self.controller.path.unlink()
        warm.write_json(self.controller.root / 'warm-started.json', {'pid': 999999, 'at': base.stamp()})
        self.assertFalse(warm.watchdog_step(self.config, base, alive=lambda pid: True))
        self.assertTrue(warm.watchdog_step(self.config, base, alive=lambda pid: False))

    def test_run_keeps_external_watchdog_when_only_vm_or_key_cleanup_failed(self):
        settings = configuration(self.root / 'cli')
        config_path = self.root / 'cli-config.json'
        config_path.write_text(json.dumps(settings))
        path = Path(settings['runtime_dir']) / 'state.json'
        controller = mock.Mock(path=path)
        controller.read.side_effect = lambda: json.loads(path.read_text())
        def failed_run():
            warm.write_json(path, {'finished_at': None, 'cleanup_errors': ['key cleanup failed']})
            raise RuntimeError('test execution failed')
        controller.run.side_effect = failed_run
        with mock.patch.object(sys, 'argv', ['ci-fanout-warm.py', '--config', str(config_path), 'run']), \
             mock.patch.object(warm, 'load_controller', return_value=base), \
             mock.patch.object(warm, 'controller_class', return_value=lambda config: controller), \
             mock.patch.object(base, 'Controller') as cleanup_controller, \
             mock.patch.object(warm, 'cleanup_volumes', return_value=True), \
             mock.patch.object(warm.subprocess, 'Popen') as process:
            cleanup_controller.return_value.cleanup.side_effect = RuntimeError('key cleanup failed')
            with self.assertRaisesRegex(RuntimeError, 'key cleanup failed'):
                warm.main()
        process.return_value.terminate.assert_not_called()
        process.return_value.wait.assert_not_called()

    def test_absolute_campaign_deadline_caps_initialize_and_expired_plan(self):
        newroot = self.root / 'continued'
        newroot.mkdir()
        settings = configuration(newroot)
        Path(settings['doctl_config']).write_text('fixture only')
        deadline = base.utcnow() + dt.timedelta(minutes=5)
        settings['absolute_deadline'] = deadline.isoformat()
        controller = warm.controller_class(base, lambda path: self.api)(settings)
        with mock.patch.object(base, 'execute', return_value=''):
            controller.initialize({'dagger_version': '0.0.1'})
        self.assertEqual(warm.timestamp(controller.read()['deadline']), deadline)
        with mock.patch.object(base, 'utcnow', return_value=deadline + dt.timedelta(seconds=1)):
            with self.assertRaisesRegex(TimeoutError, 'campaign deadline'):
                controller.plan()

    def test_independent_watchdog_cleans_after_parent_death_before_deadline(self):
        self.create()
        root = self.controller.root
        warm.write_json(root / 'warm-started.json', {'pid': 999999, 'at': base.stamp()})
        def cleanup(reason):
            self.controller.remove('node-001')
            self.controller.update(lambda state: state.update(finished_at=base.stamp()))
        cleanup_volumes = warm.cleanup_volumes
        with mock.patch.object(base, 'Controller') as constructor, \
             mock.patch.object(warm, 'cleanup_volumes', side_effect=lambda c, m: cleanup_volumes(c, m, self.api)):
            constructor.return_value.cleanup.side_effect = cleanup
            self.assertTrue(warm.watchdog_step(self.config, base, alive=lambda pid: False))
        self.assertEqual(self.api.volumes['alpha'], [])

    def test_watchdog_deadline_and_failed_key_cleanup_still_release_detached_volumes(self):
        self.create()
        root = self.controller.root
        warm.write_json(root / 'warm-started.json', {'pid': 999999, 'at': base.stamp()})
        self.controller.update(lambda state: state.update(deadline=(base.utcnow() - dt.timedelta(seconds=1)).isoformat()))
        def cleanup(reason):
            self.controller.remove('node-001')
            self.controller.update(lambda state: state.update(status='cleanup_failed', cleanup_errors=['key failure']))
            raise RuntimeError('key failure')
        cleanup_volumes = warm.cleanup_volumes
        with mock.patch.object(base, 'Controller') as constructor, \
             mock.patch.object(warm, 'cleanup_volumes', side_effect=lambda c, m: cleanup_volumes(c, m, self.api)):
            constructor.return_value.cleanup.side_effect = cleanup
            with self.assertRaisesRegex(RuntimeError, 'key failure'):
                warm.watchdog_step(self.config, base, alive=lambda pid: True)
        self.assertEqual(self.api.volumes['alpha'], [])

    def test_config_requires_current_budget_authorization_and_per_account_snapshots(self):
        for field, value in [('authorization', ''), ('max_total_usd', .1),
                             ('test_run_key', 'old-key'), ('batch_key', 'Uppercase'),
                             ('source_snapshots', {'alpha': {'id': 'x', 'name': 'x'}}),
                             ('artifact_cache_dir', '/unmounted-cache'),
                             ('absolute_deadline', '2026-01-01T00:00:00')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                warm.validate_config(dict(self.config, **{field: value}), base)
        for field in ('max_hours', 'expected_hourly_rate', 'expected_volume_hourly_rate', 'max_total_usd', 'doctl_config'):
            candidate = dict(self.config)
            del candidate[field]
            with self.subTest(field=field), self.assertRaises(ValueError):
                warm.validate_config(candidate, base)


    def startup_fixture(self):
        node=self.create()
        entry=next(iter(json.loads((self.controller.root/'warm-volumes.json').read_text()).values()))
        device='/dev/disk/by-id/scsi-0DO_Volume_'+entry['name']
        observation={'volume_name':entry['name'],'device':device,'mount_target':'/mnt/atomic-ci',
                     'mount_source':device,'filesystem_type':'ext4','filesystem_uuid':'fixture-fs-uuid',
                     'docker_root_dir':'/mnt/atomic-ci/docker','restored_docker_entries':3,
                     'restored_dagger_cache_nonempty':True,'engine_images':['registry.dagger.io/engine:v0.0.1'],
                     'engine_version':'0.0.1','cache_namespace':'fixturewarm'}
        engine={'id':'c'*64,'name':'/dagger-engine-v0.0.1','image':'registry.dagger.io/engine:v0.0.1',
                'image_id':'sha256:'+'d'*64,'mount_name':'e'*64,
                'mount_source':'/mnt/atomic-ci/docker/volumes/'+'e'*64+'/_data'}
        observation.update(restored_engine=engine,started_engine=dict(engine),
                           restored_container_config_sha256='f'*64)
        return node,entry,observation

    def restored_engine_fixture(self):
        root=(self.root/'restored-docker').resolve()
        container=root/'containers'/('c'*64)/'config.v2.json'
        cache=root/'volumes'/('e'*64)/'_data'
        container.parent.mkdir(parents=True)
        cache.mkdir(parents=True)
        (cache/'metadata.db').write_text('restored engine state')
        data={'ID':'c'*64,'Name':'/dagger-engine-v0.0.1','Image':'sha256:'+'d'*64,
              'Config':{'Image':'registry.dagger.io/engine:v0.0.1'},
              'MountPoints':{'/var/lib/dagger':{'Destination':'/var/lib/dagger','Type':'volume',
                              'Driver':'local','Name':'e'*64,'Source':str(cache)}}}
        container.write_text(json.dumps(data))
        return root,container,cache,data

    def test_anonymous_cache_volume_is_proven_by_stopped_container_binding_not_its_name(self):
        root,container,cache,data=self.restored_engine_fixture()
        proof=warm.observe_restored_engine(str(root),'0.0.1')
        self.assertTrue(proof['restored_dagger_cache_nonempty'])
        self.assertEqual(proof['restored_engine']['mount_source'],str(cache))
        self.assertEqual(proof['restored_engine']['mount_name'],'e'*64)
        self.assertEqual(len(proof['restored_container_config_sha256']),64)
        # The old heuristic sees no directory whose name contains "dagger".
        self.assertEqual(list((root/'volumes').glob('*dagger*/_data')),[])

    def test_stopped_engine_rejects_wrong_identity_and_foreign_or_unbound_caches(self):
        root,container,cache,data=self.restored_engine_fixture()
        variants=[]
        for key,value in [('ID','b'*64),('Name','/other-service'),('Image','sha256:wrong')]:
            candidate=copy.deepcopy(data);candidate[key]=value;variants.append(candidate)
        candidate=copy.deepcopy(data);candidate['Config']['Image']='registry.dagger.io/engine:v0.0.2';variants.append(candidate)
        for key,value in [('Destination','/other'),('Type','bind'),('Driver','foreign'),
                          ('Name','../escape'),('Source',str(root.parent/'foreign'))]:
            candidate=copy.deepcopy(data);candidate['MountPoints']['/var/lib/dagger'][key]=value;variants.append(candidate)
        candidate=copy.deepcopy(data);candidate['MountPoints']={};variants.append(candidate)
        for candidate in variants:
            with self.subTest(candidate=candidate),self.assertRaises(ValueError):
                container.write_text(json.dumps(candidate))
                warm.observe_restored_engine(str(root),'0.0.1')

    def test_stopped_engine_rejects_empty_and_symlinked_cache_or_docker_roots(self):
        root,container,cache,data=self.restored_engine_fixture()
        (cache/'metadata.db').unlink()
        with self.assertRaisesRegex(ValueError,'empty'):
            warm.observe_restored_engine(str(root),'0.0.1')
        cache.rmdir()
        foreign=root.parent/'foreign-cache';foreign.mkdir();(foreign/'metadata.db').write_text('foreign')
        cache.symlink_to(foreign,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'symlink'):
            warm.observe_restored_engine(str(root),'0.0.1')
        linked=root.parent/'linked-docker';linked.symlink_to(root,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'symlink'):
            warm.observe_restored_engine(str(linked),'0.0.1')

    def test_stopped_engine_rejects_duplicate_metadata_and_symlinked_container_configs(self):
        root,container,cache,data=self.restored_engine_fixture()
        duplicate=root/'containers'/('b'*64)/'config.v2.json'
        duplicate.parent.mkdir();duplicate.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError,'exactly one'):
            warm.observe_restored_engine(str(root),'0.0.1')
        duplicate.unlink();duplicate.parent.rmdir()
        saved=root.parent/'saved-config.json';container.rename(saved);container.symlink_to(saved)
        with self.assertRaisesRegex(ValueError,'symlink'):
            warm.observe_restored_engine(str(root),'0.0.1')

    def test_post_start_inspection_uses_config_image_even_when_image_catalog_is_empty(self):
        node,entry,observation=self.startup_fixture()
        engine=observation['restored_engine']
        raw={'Id':engine['id'],'Name':engine['name'],'Image':engine['image_id'],
             'Config':{'Image':engine['image'],'Env':['DO_NOT_EXPOSE=fixture']},
             'Mounts':[{'Destination':'/var/lib/dagger','Type':'volume','Driver':'local',
                        'Name':engine['mount_name'],'Source':engine['mount_source']}]}
        with mock.patch.object(subprocess,'check_output',return_value=json.dumps([raw])) as read:
            after=warm.observe_started_engine(engine)
        self.assertEqual(after,engine)
        self.assertEqual(read.call_args.args[0],['docker','inspect','--type','container',engine['id']])
        self.assertNotIn('DO_NOT_EXPOSE',json.dumps(after))
        observation.update(started_engine=after,engine_images=[after['image']],docker_image_count=0)
        self.assertTrue(warm.validate_startup_cache(self.config,node,entry,observation)['restoration_verified'])

    def test_startup_proof_rejects_container_or_mount_replaced_after_docker_start(self):
        node,entry,observation=self.startup_fixture()
        for field,value in [('id','b'*64),('image_id','sha256:'+'a'*64),('mount_source','/foreign'),
                            ('image','registry.dagger.io/engine:v0.0.2'),('name','/unrelated')]:
            candidate=copy.deepcopy(observation);candidate['started_engine'][field]=value
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'started_engine'):
                warm.validate_startup_cache(self.config,node,entry,candidate)

    def test_startup_proof_proves_restoration_but_never_claims_job_cache_hits(self):
        node,entry,observation=self.startup_fixture()
        proof=warm.validate_startup_cache(self.config,node,entry,observation)
        self.assertTrue(proof['restoration_verified'])
        self.assertFalse(proof['cache_hits_proven'])
        self.assertEqual(proof['volume_id'],entry['id'])
        self.assertEqual(proof['snapshot_id'],'snapshot-alpha')
        self.assertEqual(proof['node_id'],'node-001')
        self.assertEqual(proof['account'],'alpha')
        self.assertEqual(proof['dagger_engine_version'],'0.0.1')
        self.assertEqual(proof['docker_root_dir'],'/mnt/atomic-ci/docker')
        self.assertEqual(proof['cache_namespace'],'fixturewarm')

    def test_real_prepare_validates_attached_clone_and_persists_compilable_startup_collector_proof(self):
        node,entry,observation=self.startup_fixture()
        with mock.patch.object(base.Controller,'prepare',side_effect=lambda key:(self.controller.root/key).mkdir(exist_ok=True)), \
             mock.patch.object(self.controller,'ssh',return_value=json.dumps(observation)) as ssh:
            type(self.controller).prepare(self.controller,node['id'])
        argv=shlex.split(ssh.call_args.args[1])
        self.assertEqual(argv[:2],['python3','-c'])
        compile(argv[2],'<actual-worker-startup-collector>','exec')
        proof=json.loads((self.controller.root/node['id']/'cache-startup.json').read_text())
        self.assertEqual(proof['volume_id'],entry['id'])
        self.assertTrue(proof['restoration_verified'])
        self.assertFalse(proof['cache_hits_proven'])
        self.assertEqual(self.controller.read()['nodes'][node['id']]['cache_startup_proof'],proof)

    def test_real_prepare_preserves_raw_failed_observation_before_validation_raises(self):
        node,entry,observation=self.startup_fixture()
        observation.update(restored_dagger_cache_nonempty=False,engine_images=[])
        with mock.patch.object(base.Controller,'prepare',side_effect=lambda key:(self.controller.root/key).mkdir(exist_ok=True)), \
             mock.patch.object(self.controller,'ssh',return_value=json.dumps(observation)):
            with self.assertRaisesRegex(ValueError,'restored_dagger_cache_nonempty.*engine_images') as failure:
                type(self.controller).prepare(self.controller,node['id'])
        directory=self.controller.root/node['id']
        raw=json.loads((directory/'cache-startup-observation.json').read_text())
        self.assertEqual(raw,observation)
        self.assertFalse((directory/'cache-startup.json').exists())
        self.assertIn('observed=False',str(failure.exception))
        state=self.controller.read()['nodes'][node['id']]
        self.assertEqual(state['cache_startup_error'],str(failure.exception))
        self.assertEqual(Path(state['cache_startup_observation_path']),directory/'cache-startup-observation.json')
        self.assertNotIn('cache_startup_proof',state)

    def test_startup_proof_rejects_empty_or_different_restored_cache_and_runtime(self):
        node,entry,observation=self.startup_fixture()
        changes=[('volume_name','foreign'),('device','/dev/foreign'),('mount_target','/other'),
                 ('mount_source','/dev/foreign'),('filesystem_type','xfs'),('filesystem_uuid',''),
                 ('docker_root_dir','/var/lib/docker'),('restored_docker_entries',0),
                 ('restored_docker_entries',True),('restored_dagger_cache_nonempty',False),
                 ('engine_images',[]),('engine_images',['unrelated-service:0.0.1']),
                 ('engine_version','0.0.2'),('cache_namespace','wrong-namespace')]
        for field,value in changes:
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):
                warm.validate_startup_cache(self.config,node,entry,dict(observation,**{field:value}))

    def test_diagnostic_validation_retains_strict_boolean_ownership_proof(self):
        node,entry,observation=self.startup_fixture()
        with self.assertRaisesRegex(ValueError,'ledger.absence_verified.*observed=1'):
            warm.validate_startup_cache(self.config,node,dict(entry,absence_verified=1),observation)

    def test_readonly_plan_rejects_wrong_candidate_engine_and_snapshot_namespace_before_clones(self):
        for field,value in [('dagger_engine_version','0.0.2'),('cache_namespace','other'),
                            ('architecture','linux/arm64'),('docker_data_root','/var/lib/docker')]:
            config=copy.deepcopy(self.config)
            config['source_snapshots']['alpha'][field]=value
            with self.subTest(field=field),mock.patch.object(base,'execute',side_effect=self.git_output),self.assertRaises(ValueError):
                warm.controller_class(base,lambda _:self.api)(config).plan()
            self.assertEqual(self.api.mutations,[])

    def test_raw_cache_observation_is_captured_before_first_docker_start(self):
        text=self.controller.cloud_init('0.0.1')
        commands=[json.loads(line[4:]) for line in text.splitlines() if line.startswith('  - ["bash"')]
        script=commands[0][-1]
        marker='/var/lib/atomic-ci-cache-before-start.json'
        self.assertIn(marker,script)
        self.assertLess(script.index(marker),script.index('systemctl enable --now docker'))
        self.assertNotIn('docker pull',script)
        self.assertNotIn('*dagger*/_data',script)
        self.assertIn('config.v2.json',script)
        self.assertIn('restored_engine_error',script)
        subprocess.run(['bash','-n'],input=script,text=True,check=True)


if __name__ == '__main__':
    unittest.main()
