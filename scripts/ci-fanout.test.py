#!/usr/bin/env python3
"""Behavioral regressions for billing/ownership and complete browser coverage.

All DigitalOcean and SSH effects below are fakes. No token or paid host is used.
"""
from __future__ import annotations

import copy
import datetime as dt
import importlib.util
import json
import shutil
import subprocess
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
        self.stale_key_reads = {}
        self.stale_after_key_delete = 0

    def raw(self, account, args):
        context = account['context']
        if args[:2] == ['account', 'get']:
            return [{'team': {'uuid': self.actual[context]}, 'droplet_limit': 100}]
        resource = self.droplets if args[1] == 'droplet' else self.keys
        if args[2] == 'list':
            stale = self.stale_key_reads.get(context) if args[1] == 'ssh-key' else None
            if stale and stale[1] > 0:
                stale[1] -= 1
                return copy.deepcopy(resource[context] + stale[0])
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
            if args[1] == 'ssh-key' and self.stale_after_key_delete:
                removed = [item for item in resource[context] if item['id'] == int(args[3])]
                self.stale_key_reads[context] = [copy.deepcopy(removed), self.stale_after_key_delete]
            resource[context][:] = [item for item in resource[context] if item['id'] != int(args[3])]
            return None
        raise AssertionError(args)


class FakeController(fanout.Controller):
    def __init__(self, settings, api):
        super().__init__(settings, api)
        self.events = []
        self.fail_canary = False
        self.fail_inputs = False

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

    def source_inputs(self, nodes):
        self.events.append(('source-inputs', tuple(nodes)))

    def source_preflight(self, builder, canary):
        self.events.append('source-preflight')
        if self.fail_inputs:
            raise ValueError('Source inputs differ before build/browser: fixture-file')

    def archive_bundle(self, builder):
        self.events.append(('archive', builder))
        self.node_update(builder, bundle_archived_at=fanout.stamp())

    def restore_bundle(self, builder):
        self.events.append(('restore', builder))

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


class RunnerResourceTests(unittest.TestCase):
    def test_commands_receive_configured_resources_without_changing_probes(self):
        spec = importlib.util.spec_from_file_location('runner_fixture', Path(__file__).with_name('ci-fanout-runner.py'))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        cases = [('check', None, ['rust-test'], {}, ['--max-build-jobs', '4', '--build-jobs', '4', 'rust-test']),
                 ('check', None, ['rust-test'], {'build_jobs': 64, 'rust_test_threads': 48},
                  ['--max-build-jobs', '64', '--build-jobs', '64', 'rust-test', '--test-threads', '48']),
                 ('check', None, ['rust-clippy'], {'build_jobs': 64, 'rust_test_threads': 48},
                  ['--max-build-jobs', '64', '--build-jobs', '64', 'rust-clippy']),
                 ('probe', '/fixture/probe', ['build'], {'build_jobs': 64}, ['dagger', '-m', '/fixture/probe', 'call', 'build'])]
        for kind, module, args, widths, expected in cases:
            with self.subTest(kind=kind, args=args, widths=widths), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                config_path = root / 'config.json'
                config_path.write_text(json.dumps(dict(batch_key='fixture', node_id='node-001', phase='command',
                    source_commit=SHA, kind=kind, module=module, args=args, **widths)))
                calls = []
                with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner, 'check_identity'), \
                     mock.patch.object(runner, 'run', side_effect=lambda command, directory, log: calls.append(command) or 0):
                    self.assertEqual(runner.main(config_path), 0)
                self.assertEqual(calls[0][-len(expected):], expected)

    def test_builder_receives_both_compile_width_flags(self):
        spec = importlib.util.spec_from_file_location('runner_builder_fixture', Path(__file__).with_name('ci-fanout-runner.py'))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); config_path = root / 'config.json'
            config_path.write_text(json.dumps(dict(batch_key='fixture', node_id='node-001', phase='build',
                source_commit=SHA, kind='builder', args=[], build_jobs=64)))
            calls = []
            def run(command, directory, log):
                calls.append(command)
                (root / 'results/build/browser-build-receipt.json').write_text('{}')
                return 0
            with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner, 'check_identity'), \
                 mock.patch.object(runner, 'run', side_effect=run):
                self.assertEqual(runner.main(config_path), 0)
            self.assertEqual(calls[0][-4:], ['--max-build-jobs', '64', '--build-jobs', '64'])

    def test_runner_rejects_invalid_width_before_any_command(self):
        spec = importlib.util.spec_from_file_location('runner_bad_fixture', Path(__file__).with_name('ci-fanout-runner.py'))
        runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config.json'
            for field, value in [('build_jobs', 0), ('build_jobs', True), ('rust_test_threads', 129)]:
                path.write_text(json.dumps({field: value}))
                with self.subTest(field=field), mock.patch.object(runner, 'run') as run, self.assertRaises(ValueError):
                    runner.main(path)
                run.assert_not_called()


class ResourceConfigTests(unittest.TestCase):
    def test_default_and_explicit_resource_widths(self):
        with tempfile.TemporaryDirectory() as temp:
            settings = config(Path(temp), 4)
            self.assertEqual(settings['build_jobs'], 4)
            self.assertEqual(settings['rust_test_threads'], 0)
            self.assertEqual(settings['workers'], 1)
            settings.update(build_jobs=64, rust_test_threads=48, workers=16)
            self.assertEqual(fanout.validate_config(settings), settings)
            for field, bad_values in [('build_jobs', [0, -1, 129, 1.5, True]),
                                      ('rust_test_threads', [-1, 129, 1.5, True]),
                                      ('workers', [0, 65, 1.5, True])]:
                for value in bad_values:
                    with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                        fanout.validate_config(dict(settings, **{field: value}))


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

    def test_phase_transport_preserves_explicit_resource_widths(self):
        self.controller.config.update(build_jobs=64, rust_test_threads=48, workers=16)
        self.initialize()
        self.controller.node_update('node-001', status='ready')
        self.controller.update(lambda value: value.update(
            deadline=(fanout.utcnow() + dt.timedelta(hours=1)).isoformat()))
        actual = fanout.Controller(self.controller.config, self.api)
        (actual.root / 'node-001').mkdir()
        with mock.patch.object(actual, 'scp'), mock.patch.object(actual, 'ssh'), mock.patch.object(actual, 'event'):
            actual.phase('node-001', 'check-rust-test', 'check', ['rust-test'])
        phase = actual.read()['nodes']['node-001']['phase_config']
        self.assertEqual((phase['build_jobs'], phase['rust_test_threads']), (64, 48))
        self.assertEqual(phase['args'], ['rust-test'])

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

    def test_ssh_key_deletion_waits_for_stale_listing_without_redeleting(self):
        self.initialize()
        self.api.stale_after_key_delete = 2
        with mock.patch.object(fanout.time, 'sleep') as sleep:
            self.controller.cleanup('eventually consistent keys')
        self.assertEqual(sleep.call_count, 4)
        self.assertEqual(self.controller.read()['status'], 'stopped')
        deletes = [args for _,args in self.api.mutations if args[:3] == ['compute','ssh-key','delete']]
        self.assertEqual(len(deletes), 2)
        self.assertTrue(all(key['deletion_verified'] for key in self.controller.read()['keys'].values()))

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

    def test_canonical_input_mismatch_records_changed_paths_and_both_manifests(self):
        self.initialize()
        for key in ('node-001','node-002'):
            (self.controller.root / key).mkdir()
        original = {'fingerprintVersion':2,'fingerprint':'a'*64,
                    'files':[['source.ts','file',0,'original']],'directories':[]}
        changed = {'fingerprintVersion':2,'fingerprint':'b'*64,
                   'files':[['source.ts','file',0,'changed']],'directories':[]}
        with mock.patch.object(self.controller, 'ssh', side_effect=[json.dumps(original),json.dumps(changed)]):
            with self.assertRaisesRegex(ValueError, 'source.ts'):
                fanout.Controller.source_inputs(self.controller, ['node-001','node-002'])
        self.assertEqual(self.controller.read()['nodes']['node-002']['source_input_differences'], ['source.ts'])
        for key in ('node-001','node-002'):
            self.assertTrue((self.controller.root / key / 'source-inputs.json').is_file())

    def test_setup_byte_change_fails_real_before_after_gate_on_only_two_hosts(self):
        controller = self.controller
        source = self.root / 'input.txt'
        source.write_text('pristine')
        controller.source_inputs = lambda nodes: fanout.Controller.source_inputs(controller, nodes)
        controller.source_preflight = lambda builder,canary: fanout.Controller.source_preflight(controller,builder,canary)
        original_prepare = controller.prepare
        def prepare(key):
            original_prepare(key)
            (controller.root / key).mkdir()
        original_phase = controller.phase
        def phase(key,name,kind,args,preflight=False,module=None):
            original_phase(key,name,kind,args,preflight,module)
            if preflight:
                source.write_text('changed during preflight')
        def inputs(*args,**kwargs):
            checksum = fanout.file_sha256(source)
            return json.dumps({'fingerprintVersion':2,'fingerprint':checksum,
                'files':[['input.txt','file',0,checksum]],'directories':[]})
        with mock.patch.object(controller,'prepare',side_effect=prepare), mock.patch.object(controller,'phase',side_effect=phase), mock.patch.object(controller,'ssh',side_effect=inputs), mock.patch.object(fanout.subprocess,'Popen') as process:
            process.return_value.pid = 12345
            process.return_value.poll.return_value = 0
            with self.assertRaisesRegex(ValueError,'input.txt'):
                controller.run()
        self.assertEqual(controller.read()['nodes']['node-001']['source_input_differences'], ['input.txt'])
        self.assertEqual(len([args for _,args in self.api.mutations if args[:3] == ['compute','droplet','create']]),2)
        self.assertFalse(any(isinstance(item,tuple) and item[1]=='build' for item in controller.events))

    def test_running_rust_is_retained_without_extending_the_existing_deadline(self):
        self.initialize()
        self.controller.create('node-001')
        self.controller.node_update('node-001',phase='check-rust-test',status='running')
        deadline = self.controller.read()['deadline']
        future = mock.Mock()
        future.done.return_value = True
        with mock.patch.object(self.controller,'retrieve') as retrieve:
            fanout.Controller.preserve_rust(self.controller, {'node-001':future})
        future.result.assert_called_once_with()
        retrieve.assert_called_once_with('node-001')
        self.assertEqual(self.controller.read()['deadline'],deadline)

    def test_input_mismatch_stops_before_expensive_build_and_only_two_hosts_exist(self):
        self.controller.fail_inputs = True
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'Source inputs differ'):
                self.controller.run()
        created = [args for _, args in self.api.mutations if args[:3] == ['compute', 'droplet', 'create']]
        self.assertEqual(len(created), 2)
        self.assertFalse(any(isinstance(item, tuple) and item[1] == 'build' for item in self.controller.events))
        self.assertEqual(sum(len(value) for value in self.api.droplets.values()), 0)

    def test_canary_failure_never_provisions_remaining_nine_nodes(self):
        self.controller.fail_canary = True
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'canary'):
                self.controller.run()
        created = [args for _, args in self.api.mutations if args[:3] == ['compute', 'droplet', 'create']]
        self.assertEqual(len(created), 11)
        archive = self.controller.events.index(('archive', 'node-001'))
        browser = self.controller.events.index(('node-002', 'browser'))
        self.assertLess(archive, browser)
        self.assertEqual(sum(len(value) for value in self.api.droplets.values()), 0)
        self.assertEqual(self.controller.read()['status'], 'stopped')

    def test_archive_preserves_real_payload_and_original_build_evidence_then_restores(self):
        self.initialize()
        self.controller.create('node-001')
        payload = self.root / 'payload'
        payload.mkdir()
        for name in fanout.BUNDLE_FILES[1:]:
            (payload / name).write_text('fixture ' + name)
        manifest = {'sourceCommit':SHA, 'platform':'linux/amd64',
                    'files':{name:fanout.file_sha256(payload / name) for name in fanout.BUNDLE_FILES[1:]}}
        (payload / 'manifest.json').write_text(json.dumps(manifest))
        result = {'status':'passed', 'source_commit':SHA, 'node_id':'node-001', 'phase':'build',
                  'batch_key':self.controller.config['batch_key'], 'started_at':'original-start',
                  'finished_at':'original-finish', 'commands':[{'exit_code':0,'command':['dagger','prepare-browser-bundle']}]}
        self.controller.update(lambda state:state.update(bundle={'manifest_sha256':fanout.file_sha256(payload / 'manifest.json')}))
        self.controller.update(lambda state:state['nodes']['node-001']['phase_results'].update(build=result))
        self.controller.update(lambda state:state.update(deadline=(fanout.utcnow()+dt.timedelta(seconds=10)).isoformat()))
        def download(node, sources, destination, download=False, timeout=180):
            self.assertTrue(download)
            self.assertGreater(timeout,0)
            self.assertLessEqual(timeout,10)
            for source in sources:
                shutil.copy2(payload / Path(source).name, destination)
        with mock.patch.object(self.controller, 'scp', side_effect=download):
            archived = fanout.Controller.archive_bundle(self.controller, 'node-001')
        receipt, recovered = fanout.validate_archive(archived, SHA)
        self.assertEqual(receipt['build_started_at'], 'original-start')
        self.assertEqual(receipt['build_finished_at'], 'original-finish')
        self.assertEqual(recovered, manifest)
        self.assertEqual((archived / 'bundle/client.oci.tar').read_bytes(), (payload / 'client.oci.tar').read_bytes())
        with mock.patch.object(self.controller, 'scp') as upload, mock.patch.object(self.controller, 'ssh', return_value=''):
            fanout.Controller.restore_bundle(self.controller, 'node-001')
        self.assertEqual(upload.call_count, 2)
        self.assertEqual(self.controller.read()['nodes']['node-001']['restored_bundle_archive'], str(archived))
        self.controller.update(lambda state:state.update(deadline=(fanout.utcnow()-dt.timedelta(seconds=1)).isoformat()))
        with mock.patch.object(self.controller,'scp') as no_copy:
            self.assertEqual(fanout.Controller.archive_bundle(self.controller,'node-001'),archived)
            no_copy.assert_not_called()
            preserved = archived.with_name('preserved-successful-archive')
            archived.rename(preserved)
            with self.assertRaisesRegex(TimeoutError,'deadline reached'):
                fanout.Controller.archive_bundle(self.controller,'node-001')
            no_copy.assert_not_called()
            preserved.rename(archived)
        (archived / 'bundle/client.oci.tar').write_text('corrupt')
        with self.assertRaisesRegex(ValueError, 'payload hash mismatch'):
            fanout.validate_archive(archived, SHA)

    def test_failed_backup_is_reported_without_stranding_paid_hosts(self):
        self.initialize()
        self.controller.create('node-001')
        self.controller.update(lambda state:state['nodes']['node-001']['phase_results'].update({'build':{'status':'passed'}}))
        with mock.patch.object(self.controller, 'archive_bundle', side_effect=TimeoutError('bounded archive copy failed')):
            self.controller.cleanup('fixture failure')
        state = self.controller.read()
        self.assertIn('bounded archive', state['nodes']['node-001']['bundle_backup_error'])
        self.assertTrue(state['nodes']['node-001']['deletion_verified'])

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
