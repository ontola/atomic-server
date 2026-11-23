#!/usr/bin/env python3
"""Behavioral regressions for billing/ownership and complete browser coverage.

All DigitalOcean and SSH effects below are fakes. No token or paid host is used.
"""
from __future__ import annotations

import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('fanout', Path(__file__).with_name('ci-fanout.py'))
fanout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fanout)
SHA = 'a' * 40
UUIDS = {'default': '11111111-1111-1111-1111-111111111111',
         'personal': '22222222-2222-2222-2222-222222222222'}


def config(root, count=20):
    return fanout.validate_config({'batch_key': 'fixture-ci', 'source_commit': SHA,
        'worktree': str(root / 'repo'), 'runtime_dir': str(root / 'runtime'),
        'doctl_config': str(root / 'credentials'), 'oci_probe_dir': str(root / 'probe'),
        'accounts': [{'context': context, 'expected_uuid': uuid, 'nodes': count // 2}
                     for context, uuid in UUIDS.items()]})


def report(indices, index=None, total=20):
    value = {'config': {}, 'errors': [], 'suites': [{'title': 'feature.spec.ts', 'file': 'feature.spec.ts',
        'specs': [{'title': 'case ' + str(number), 'file': 'feature.spec.ts',
                   'line': number, 'column': 1,
                   'tests': [{'projectName': 'chromium', 'status': 'expected',
                              'results': [{'status': 'passed'}]}]}
                  for number in indices]}]}
    if index is not None:
        value['config']['shard'] = {'current': index, 'total': total}
    return value


class FakeAPI(fanout.DigitalOcean):
    def __init__(self):
        super().__init__('unused')
        self.actual = dict(UUIDS)
        self.droplets = {key: [] for key in UUIDS}
        self.keys = {key: [] for key in UUIDS}
        self.next_id = 100
        self.mutations = []
        self.lose_create = False

    def raw(self, account, args):
        context = account['context']
        if args[:2] == ['account', 'get']:
            return [{'team': {'uuid': self.actual[context]}, 'droplet_limit': 100}]
        resource = self.droplets if args[1] == 'droplet' else self.keys
        if args[2] == 'list':
            return copy.deepcopy(resource[context])
        self.mutations.append((context, list(args)))
        if args[2] in ('import', 'create'):
            self.next_id += 1
            item = {'id': self.next_id, 'name': args[3]}
            if args[1] == 'droplet':
                item.update(created_at=fanout.stamp(), size_slug='s-4vcpu-8gb-240gb-intel',
                            size={'price_hourly': .09524}, status='active', networks={'v4': []})
            else:
                item.update(fingerprint='fixture-fingerprint', public_key='ssh-ed25519 FIXTURE')
            resource[context].append(item)
            if self.lose_create and args[1] == 'droplet':
                self.lose_create = False
                raise TimeoutError('create response was lost after resource creation')
            return [copy.deepcopy(item)]
        if args[2] == 'delete':
            resource[context][:] = [item for item in resource[context] if item['id'] != int(args[3])]
            return None
        raise AssertionError(args)


class FakeController(fanout.Controller):
    def __init__(self, settings, api):
        super().__init__(settings, api)
        self.events = []
        self.fail_canary = False

    def event(self, value):
        self.events.append(value)

    def initialize(self, plan):
        self.root.mkdir(parents=True)
        (self.root / 'config.json').write_text(json.dumps(self.config))
        nodes = {}
        index = 0
        for account in self.config['accounts']:
            for _ in range(account['nodes']):
                index += 1
                key = 'node-' + str(index).zfill(3)
                nodes[key] = {'id': key, 'account': account['context'],
                              'name': self.config['batch_key'] + '-' + key, 'shard_index': index,
                              'status': 'planned', 'phase_results': {}}
        self.path.write_text(json.dumps({'config': self.config, 'nodes': nodes, 'keys': {},
            'batch_key': self.config['batch_key'], 'source_commit': SHA, 'plan': plan,
            'stop_requested': False, 'status': 'initialized'}))
        (self.root / 'operator-key.pub').write_text('ssh-ed25519 FIXTURE')

    def plan(self):
        return {'nodes': sum(item['nodes'] for item in self.config['accounts']), 'dagger_version': '0.21.7'}

    def prepare(self, node_id):
        self.node_update(node_id, status='ready')

    def tiny_probe(self, builder, worker):
        self.events.append('tiny-probe')
        self.update(lambda value: value.update(oci_probe_passed_at=fanout.stamp()))

    def phase(self, node_id, name, kind, args, preflight=False, module=None):
        self.check_deadline()
        result = {'source_commit': SHA, 'status': 'passed', 'browser_exit_code': 0}
        self.node_update(node_id, status='waiting', phase=name, phase_kind=kind,
                         last_result=result)
        self.update(lambda state: state['nodes'][node_id]['phase_results'].update({name: result}))
        self.events.append((node_id, name))

    def wait(self, nodes):
        self.check_deadline()

    def read_bundle(self, builder):
        bundle = {'inventory': report(range(1, self.plan()['nodes'] + 1)), 'manifest_sha256': 'b' * 64}
        self.update(lambda state: state.update(bundle=bundle, builder=builder))
        return bundle

    def share(self, builder, workers, **kwargs):
        self.events.append(('share', tuple(workers)))

    def verify_browser(self, node_id):
        node = self.read()['nodes'][node_id]
        if self.fail_canary and node['shard_index'] == 2:
            raise ValueError('canary exported a failing browser exit code')
        ids = fanout.report_identities(report([node['shard_index']]))
        self.node_update(node_id, browser_identities=ids, browser_verified_at=fanout.stamp())
        return ids


class CoverageTests(unittest.TestCase):
    def test_export_exit_zero_cannot_mask_browser_failure(self):
        result = {'source_commit': SHA, 'status': 'passed', 'browser_exit_code': 1}
        with self.assertRaisesRegex(ValueError, 'not browser success'):
            fanout.verify_browser_report(report([1], 1), SHA, result, 1, 20)

    def test_wrong_source_wrong_shard_and_unexpected_failure_rejected(self):
        result = {'source_commit': SHA, 'status': 'passed', 'browser_exit_code': 0}
        cases = []
        wrong = dict(result, source_commit='c' * 40)
        cases.append((report([1], 1), wrong))
        cases.append((report([1], 2), result))
        failed = report([1], 1)
        failed['suites'][0]['specs'][0]['tests'][0]['status'] = 'unexpected'
        cases.append((failed, result))
        for artifact, metadata in cases:
            with self.subTest(metadata=metadata, artifact=artifact), self.assertRaises(ValueError):
                fanout.verify_browser_report(artifact, SHA, metadata, 1, 20)

    def test_union_requires_complete_nonoverlapping_inventory(self):
        inventory = report([1, 2, 3])
        first = fanout.report_identities(report([1]))
        rest = fanout.report_identities(report([2, 3]))
        self.assertEqual(fanout.verify_suite_union(inventory, [first, rest]), 3)
        for shards in ([first], [first, first, rest]):
            with self.assertRaises(ValueError):
                fanout.verify_suite_union(inventory, shards)

    def test_retries_do_not_duplicate_identity_and_existing_skips_count(self):
        value = report([1], 1)
        test = value['suites'][0]['specs'][0]['tests'][0]
        test['status'] = 'flaky'
        test['results'] = [{'status': 'failed'}, {'status': 'passed'}]
        result = {'source_commit': SHA, 'status': 'passed', 'browser_exit_code': 0}
        self.assertEqual(len(fanout.verify_browser_report(value, SHA, result, 1, 20)), 1)
        test['status'] = 'skipped'
        self.assertEqual(len(fanout.verify_browser_report(value, SHA, result, 1, 20)), 1)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.api = FakeAPI()
        settings = config(self.root)
        self.controller = FakeController(settings, self.api)
        (self.root / 'probe').mkdir()
        (self.root / 'probe/dagger.json').write_text('{}')

    def tearDown(self):
        self.temp.cleanup()

    def initialize(self):
        self.controller.initialize(self.controller.plan())
        self.controller.register_keys()

    def test_successful_doctl_delete_can_have_empty_output(self):
        api = fanout.DigitalOcean('/unused')
        with mock.patch.object(fanout, 'execute', return_value=''):
            self.assertIsNone(api.raw(self.controller.account('default'),
                                     ['compute', 'droplet', 'delete', '123', '--force']))

    def test_account_uuid_checked_before_any_mutation(self):
        self.api.actual['personal'] = UUIDS['default']
        account = self.controller.account('personal')
        with self.assertRaisesRegex(RuntimeError, 'UUID differs'):
            self.api.call(account, ['compute', 'droplet', 'create', 'unowned'])
        self.assertEqual(self.api.mutations, [])

    def test_deadline_prevents_create_and_cleanup_removes_both_accounts_only(self):
        self.initialize()
        for key in ('node-001', 'node-011'):
            self.controller.create(key)
        for account in UUIDS:
            self.api.droplets[account].append({'id': 900, 'name': 'existing-unrelated-' + account})
        self.controller.update(lambda state: state.update(deadline=(fanout.utcnow() - dt.timedelta(seconds=1)).isoformat()))
        before = len(self.api.mutations)
        with self.assertRaises(TimeoutError):
            self.controller.create('node-002')
        self.assertEqual(len(self.api.mutations), before)
        self.controller.cleanup('fixture deadline')
        state = self.controller.read()
        self.assertEqual(state['status'], 'stopped')
        self.assertGreater(state['estimated_compute_usd'], 0)
        for account in UUIDS:
            self.assertEqual(self.api.droplets[account], [{'id': 900, 'name': 'existing-unrelated-' + account}])
            self.assertEqual(self.api.keys[account], [])
        # A watchdog/controller cleanup race may call this again after credentials were removed.
        mutations = list(self.api.mutations)
        self.controller.cleanup('second cleanup')
        self.assertEqual(self.api.mutations, mutations)

    def test_lost_create_response_is_recorded_then_removed(self):
        self.initialize()
        self.api.lose_create = True
        with self.assertRaises(TimeoutError):
            self.controller.create('node-001')
        self.assertIsNotNone(self.controller.read()['nodes']['node-001'].get('droplet_id'))
        self.controller.cleanup('lost response')
        self.assertEqual(self.api.droplets['default'], [])

    def test_identity_mismatch_refuses_deletion(self):
        self.initialize()
        self.controller.create('node-001')
        self.api.droplets['default'][0]['name'] = 'other-task'
        with self.assertRaisesRegex(RuntimeError, 'ID/name mismatch'):
            self.controller.remove('node-001')
        self.assertEqual(len(self.api.droplets['default']), 1)

    def test_config_drift_refused_before_resource_lookup(self):
        self.initialize()
        changed = copy.deepcopy(self.controller.config)
        changed['accounts'][0]['context'] = 'different-account'
        with self.assertRaisesRegex(ValueError, 'immutable batch state'):
            fanout.Controller(changed, self.api)

    def test_canary_failure_never_provisions_remaining_nine_nodes(self):
        self.controller.fail_canary = True
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'canary'):
                self.controller.run()
        created = [args for _, args in self.api.mutations if args[:3] == ['compute', 'droplet', 'create']]
        self.assertEqual(len(created), 11)
        self.assertEqual(sum(len(value) for value in self.api.droplets.values()), 0)
        self.assertEqual(self.controller.read()['status'], 'stopped')

    def test_success_runs_checks_once_and_all_twenty_distinct_shards_then_cleans(self):
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            self.controller.run()
        state = self.controller.read()
        self.assertEqual(state['status'], 'passed')
        self.assertEqual(state['full_browser_test_count'], 20)
        checks = [item[1] for item in self.controller.events if isinstance(item, tuple) and isinstance(item[1], str) and item[1].startswith('check-')]
        self.assertCountEqual(checks, ['check-' + name for name, _ in fanout.CHECKS])
        browsers = [item[0] for item in self.controller.events if isinstance(item, tuple) and item[1] == 'browser']
        self.assertEqual(len(browsers), len(set(browsers)))
        self.assertEqual(len(browsers), 20)
        self.assertTrue(all(node.get('deletion_verified') for node in state['nodes'].values()))
        self.assertEqual(sum(len(value) for value in self.api.droplets.values()), 0)
        self.assertEqual(sum(len(value) for value in self.api.keys.values()), 0)


if __name__ == '__main__':
    unittest.main()
