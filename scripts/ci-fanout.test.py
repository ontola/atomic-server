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
import threading
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('fanout', Path(__file__).with_name('ci-fanout.py'))
fanout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fanout)
SHA = 'a' * 40
UUIDS = {'default': '11111111-1111-1111-1111-111111111111',
         'personal': '22222222-2222-2222-2222-222222222222'}


def prepared_bundle(root):
    root.mkdir()
    for name in fanout.BUNDLE_FILES[1:]:
        (root / name).write_text('fixture ' + name)
    manifest = {'version': 2, 'sourceCommit': SHA, 'platform': 'linux/amd64',
                'files': {name: fanout.file_sha256(root / name) for name in fanout.BUNDLE_FILES[1:]}}
    (root / 'manifest.json').write_text(json.dumps(manifest))
    return manifest


def config(root, count=20):
    return fanout.validate_config({'batch_key': 'fixture-ci', 'source_commit': SHA,
        'worktree': str(root / 'repo'), 'runtime_dir': str(root / 'runtime'),
        'doctl_config': str(root / 'credentials'), 'oci_probe_dir': str(root / 'probe'),
        'accounts': [{'context': context, 'expected_uuid': uuid, 'nodes': count // 2}
                     for context, uuid in UUIDS.items()]})


def report(indices, index=None, total=20):
    value = {'config': {'projects': [{'name': 'chromium', 'retries': 0}]}, 'errors': [], 'suites': [{'title': 'feature.spec.ts', 'file': 'feature.spec.ts',
        'specs': [{'title': 'case ' + str(number), 'file': 'feature.spec.ts', 'id': 'case-' + str(number),
                   'line': number, 'column': 1,
                   'tests': [{'projectName': 'chromium', 'status': 'expected', 'expectedStatus': 'passed',
                              'results': [{'status': 'passed', 'retry': 0}]}]}
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
        self.lose_import = False
        self.hidden_droplets = set()
        self.hidden_keys = set()
        self.stale_key_reads = {}
        self.stale_after_key_delete = 0

    def raw(self, account, args):
        context = account['context']
        if args[:2] == ['account', 'get']:
            return [{'team': {'uuid': self.actual[context]}, 'droplet_limit': 100}]
        resource = self.droplets if args[1] == 'droplet' else self.keys
        if args[2] == 'list':
            if context in (self.hidden_droplets if args[1] == 'droplet' else self.hidden_keys):
                return []
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
            if self.lose_import and args[1] == 'ssh-key':
                self.lose_import = False
                raise TimeoutError('import response was lost after key creation')
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
        self.fail_checks = set()
        self.fail_browser_nodes = set()
        self.fail_retry_nodes = set()
        self.retry_reports = {}
        self.retry_global_error = False
        self.retry_selection_patch = {}

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
        result = {'source_commit': SHA, 'status': 'passed', 'browser_exit_code': 0,
                  'commands': [{'exit_code': 0}], 'finished_at': fanout.stamp()}
        self.node_update(node_id, status='waiting', phase=name, phase_kind=kind,
                         last_result=result)
        self.update(lambda state: state['nodes'][node_id]['phase_results'].update({name: result}))
        self.events.append((node_id, name))

    def wait(self, nodes):
        self.check_deadline()
        for key in nodes:
            node = self.read()['nodes'][key]
            if (node.get('phase') in self.fail_checks
                    or (node.get('phase') == 'browser' and key in self.fail_browser_nodes)
                    or (node.get('phase') == 'browser-retry' and key in self.fail_retry_nodes)):
                browser = node['phase'] in ('browser', 'browser-retry')
                result = dict(node['last_result'], status='failed',
                    commands=[{'exit_code': 0 if browser else 1}],
                    error='RuntimeError: browser tests exited 1' if browser else 'RuntimeError: phase command exited 1')
                if browser:
                    result['browser_exit_code'] = 1
                self.update(lambda state: state['nodes'][key]['phase_results'].update({node['phase']: result}))
                self.node_update(key, last_result=result)
                raise fanout.PhaseFailure(key, node['phase'], result)

    def read_bundle(self, builder):
        self.events.append(('bundle-ready', builder))
        bundle = {'inventory': report(range(1, self.plan()['nodes'] + 1)), 'manifest_sha256': 'b' * 64}
        self.update(lambda state: state.update(bundle=bundle, builder=builder))
        self.node_update(builder, prepared_bundle={'path': '/opt/atomic-ci/share/bundle',
                         'source_commit': SHA, 'manifest_sha256': 'b' * 64})
        return bundle

    def share(self, builder, workers, **kwargs):
        self.events.append(('share', tuple(workers)))
        for key in workers:
            self.node_update(key, prepared_bundle={'path': '/opt/atomic-ci/bundle',
                             'source_commit': SHA, 'manifest_sha256': 'b' * 64})

    def verify_browser(self, node_id, allow_failure=False):
        node = self.read()['nodes'][node_id]
        if self.fail_canary and node['shard_index'] == 2:
            raise ValueError('canary exported a failing browser exit code')
        value = report([node['shard_index']], node['shard_index'], self.plan()['nodes'])
        if node_id in self.fail_browser_nodes:
            test = value['suites'][0]['specs'][0]['tests'][0]
            test.update(status='unexpected', results=[{'status': 'failed'}])
        ids = fanout.verify_browser_report(value, SHA, node['phase_results']['browser'],
                                           node['shard_index'], self.plan()['nodes'], allow_failure)
        self.node_update(node_id, browser_identities=ids, browser_verified_at=fanout.stamp())
        self.write_browser_export(node_id, 'browser', value)
        return ids

    def write_browser_export(self, node_id, phase, value):
        node = self.read()['nodes'][node_id]
        root = self.root / node_id / 'results' / phase
        (root / 'browser/test-results').mkdir(parents=True, exist_ok=True)
        result = node['phase_results'][phase]
        (root / 'result.json').write_text(json.dumps(result))
        (root / 'browser/test-results.json').write_text(json.dumps(value))
        (root / 'browser/test-exit-code').write_text(str(result['browser_exit_code']))
        ids = [spec['id'] for _, spec, test in fanout.report_cases(value) if test['status'] == 'unexpected']
        (root / 'browser/test-results/.last-run.json').write_text(json.dumps({'status': 'failed' if ids else 'passed', 'failedTests': ids}))
        receipt = {'version': 1, 'kind': 'browser-first-pass' if phase == 'browser' else 'browser-deferred-retry',
                   'sourceCommit': SHA, 'manifestSha256': 'b' * 64, 'shardIndex': node['shard_index'],
                   'shardCount': self.plan()['nodes'], 'playwrightRetries': 0}
        for field, name in [('reportSha256', 'test-results.json'),
                            ('lastRunSha256', 'test-results/.last-run.json'), ('exitCodeSha256', 'test-exit-code')]:
            receipt[field] = fanout.file_sha256(root / 'browser' / name)
        (root / 'browser/browser-run.json').write_text(json.dumps(receipt))
        return receipt

    def run_browser_retry(self, node_id, builder):
        # The ordinary fake still exercises the real retry verifier and merger.
        super().run_browser_retry(node_id, builder)

    def browser_retry(self, node_id, builder):
        if self.read()['nodes'][node_id].get('deleted_at'):
            raise RuntimeError('failed node was deleted before its final retry')
        self.events.append(('retry-barrier', len([item for item in self.events if isinstance(item, tuple) and item[1] == 'browser'])))
        super().browser_retry(node_id, builder)

    def retrieve(self, node_id):
        node = self.read()['nodes'][node_id]
        if node.get('phase') == 'browser-retry':
            value = self.retry_reports.get(node_id) or report([node['shard_index']])
            if node_id in self.fail_retry_nodes:
                value['suites'][0]['specs'][0]['tests'][0].update(status='unexpected', results=[{'status': 'failed', 'retry': 0}])
            if self.retry_global_error:
                value['errors'] = [{'message': 'worker crashed'}]
            self.write_browser_export(node_id, 'browser-retry', value)
            first = self.verify_browser_receipt(node_id, 'browser', 'browser-first-pass')
            selection = {'version': 1, 'kind': 'browser-deferred-retry-selection', 'sourceCommit': SHA,
                         'manifestSha256': 'b' * 64, 'shardIndex': node['shard_index'], 'shardCount': self.plan()['nodes'],
                         'firstReportSha256': first['reportSha256'], 'firstLastRunSha256': first['lastRunSha256'],
                         'firstExitCodeSha256': first['exitCodeSha256'],
                         'failedTestIds': list(fanout.failed_browser_cases(self.read_browser_report(node_id)).values())}
            selection.update(self.retry_selection_patch)
            path = self.root / node_id / 'results/browser-retry/browser/retry-selection.json'
            path.write_text(json.dumps(selection))
        return self.root / node_id


class RunnerResourceTests(unittest.TestCase):
    def test_failed_warm_runner_preflight_prevents_expensive_dagger_setup(self):
        spec = importlib.util.spec_from_file_location('warm_preflight_runner', Path(__file__).with_name('ci-fanout-runner.py'))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / 'config.json'
            path.write_text(json.dumps({'batch_key': 'fixture', 'source_commit': SHA, 'node_id': 'node-001',
                'phase': 'source-preflight', 'kind': 'check', 'preflight': True, 'args': ['browser-source-inputs']}))
            calls = []
            def execute(command, directory, log):
                calls.append(command)
                return 1 if command[-1] == 'scripts/ci-fanout-warm.test.py' else 0
            with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner, 'check_identity'), \
                 mock.patch.object(runner, 'run', side_effect=execute):
                self.assertEqual(runner.main(path), 1)
            self.assertEqual(calls[-1][-1], 'scripts/ci-fanout-warm.test.py')
            self.assertFalse(any(command[0] in ('docker', 'dagger') for command in calls))
            result = json.loads((root / 'results/source-preflight/result.json').read_text())
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['commands'][-1]['exit_code'], 1)

    def test_prepared_checks_require_complete_matching_artifacts_before_any_dagger_call(self):
        spec = importlib.util.spec_from_file_location('prepared_runner_fixture', Path(__file__).with_name('ci-fanout-runner.py'))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        for change in ('valid', 'missing', 'corrupt', 'wrong-source', 'old-version', 'missing-key', 'direct-rebuild'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                bundle = root / 'bundle'
                manifest = prepared_bundle(bundle)
                if change == 'missing':
                    (bundle / 'checks.oci.tar').unlink()
                elif change == 'corrupt':
                    (bundle / 'checks.oci.tar').write_text('changed bytes')
                elif change in ('wrong-source', 'old-version', 'missing-key'):
                    if change == 'wrong-source':
                        manifest['sourceCommit'] = 'b' * 40
                    elif change == 'old-version':
                        manifest['version'] = 1
                    else:
                        manifest['files'].pop('checks.oci.tar')
                    (bundle / 'manifest.json').write_text(json.dumps(manifest))
                args = ['bundle-check', '--bundle', str(bundle), '--expected-commit', SHA,
                        '--manifest-sha256', fanout.file_sha256(bundle / 'manifest.json'), '--check-name', 'js-test']
                if change == 'direct-rebuild':
                    args = ['js-test']
                path = root / 'config.json'
                path.write_text(json.dumps({'source_commit': SHA, 'batch_key': 'fixture', 'node_id': 'node-001',
                    'phase': 'check-js-test', 'kind': 'check', 'args': args, 'test_run_key': 'fresh-execution'}))
                with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner, 'check_identity'), \
                     mock.patch.object(runner, 'run', return_value=0) as run:
                    if change == 'valid':
                        self.assertEqual(runner.main(path), 0)
                        command = run.call_args.args[0]
                        self.assertIn('bundle-check', command)
                        self.assertIn('fresh-execution', command)
                        self.assertEqual(command[-len(args):], args)
                    else:
                        with self.assertRaises(ValueError):
                            runner.main(path)
                        run.assert_not_called()

    def test_browser_runner_requires_a_zero_retry_first_pass_and_reads_phase_specific_retry_export(self):
        spec = importlib.util.spec_from_file_location('runner_browser_fixture', Path(__file__).with_name('ci-fanout-runner.py'))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / 'config.json'
            settings = dict(batch_key='fixture', node_id='node-001', source_commit=SHA,
                            kind='browser', phase='browser', args=['browser-shard', '--playwright-retries', '1'])
            path.write_text(json.dumps(settings))
            with mock.patch.object(runner, 'run') as run, self.assertRaisesRegex(ValueError, 'disable immediate'):
                runner.main(path)
            run.assert_not_called()
            settings.update(phase='browser-retry', args=['browser-retry', '--first-run', '/original'])
            path.write_text(json.dumps(settings))
            def execute(command, directory, log):
                exported = root / 'results/browser-retry/browser'
                exported.mkdir()
                (exported / 'test-results.json').write_text('{"errors":[]}')
                (exported / 'test-exit-code').write_text('0')
                return 0
            with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner, 'check_identity'), \
                 mock.patch.object(runner, 'run', side_effect=execute):
                self.assertEqual(runner.main(path), 0)
            self.assertEqual(json.loads((root / 'results/browser-retry/result.json').read_text())['status'], 'passed')

    def test_commands_receive_configured_resources_without_changing_probes(self):
        spec = importlib.util.spec_from_file_location('runner_fixture', Path(__file__).with_name('ci-fanout-runner.py'))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        cases = [('check', None, ['rust-test'], {}, ['--max-build-jobs', '4', '--build-jobs', '4', 'rust-test']),
                 ('check', None, ['rust-test'], {'build_jobs': 64, 'rust_test_threads': 48},
                  ['--max-build-jobs', '64', '--build-jobs', '64', 'rust-test', '--test-threads', '48']),
                 ('check', None, ['rust-clippy'], {'build_jobs': 64, 'rust_test_threads': 48},
                  ['--max-build-jobs', '64', '--build-jobs', '64', 'rust-clippy']),
                 ('check', None, ['rust-test'], {'build_jobs': 64, 'rust_test_threads': 48,
                  'cache_namespace': 'warm-seed', 'test_run_key': 'clone-one'},
                  ['--cache-namespace', 'warm-seed', '--max-build-jobs', '64', '--build-jobs', '64',
                   '--test-run-key', 'clone-one', 'rust-test', '--test-threads', '48']),
                 ('probe', '/fixture/probe', ['build'], {'build_jobs': 64, 'test_run_key': 'clone-one', 'cache_namespace': 'warm-seed'}, ['dagger', '-m', '/fixture/probe', 'call', 'build'])]
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
                source_commit=SHA, kind='builder', args=[], build_jobs=64,
                cache_namespace='warm-seed', test_run_key='clone-one')))
            calls = []
            def run(command, directory, log):
                calls.append(command)
                (root / 'results/build/browser-build-receipt.json').write_text('{}')
                return 0
            with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner, 'check_identity'), \
                 mock.patch.object(runner, 'run', side_effect=run):
                self.assertEqual(runner.main(config_path), 0)
            self.assertEqual(calls[0][-4:], ['--max-build-jobs', '64', '--build-jobs', '64'])
            self.assertEqual(calls[0][calls[0].index('--cache-namespace') + 1], 'warm-seed')
            self.assertNotIn('--test-run-key', calls[0])

    def test_runner_rejects_invalid_width_before_any_command(self):
        spec = importlib.util.spec_from_file_location('runner_bad_fixture', Path(__file__).with_name('ci-fanout-runner.py'))
        runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config.json'
            for field, value in [('build_jobs', 0), ('build_jobs', True), ('rust_test_threads', 129),
                                 ('test_run_key', 'two words'), ('cache_namespace', '../foreign')]:
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
            self.assertEqual(settings['test_run_key'], '')
            self.assertEqual(settings['cache_namespace'], '')
            for field in ('test_run_key', 'cache_namespace'):
                for value in [True, None, 123, '../foreign', 'two words', 'x' * 82]:
                    with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                        fanout.validate_config(dict(settings, **{field: value}))
            settings.update(build_jobs=64, rust_test_threads=48, workers=16)
            self.assertEqual(fanout.validate_config(settings), settings)
            for field, bad_values in [('build_jobs', [0, -1, 129, 1.5, True]),
                                      ('rust_test_threads', [-1, 129, 1.5, True]),
                                      ('workers', [0, 65, 1.5, True])]:
                for value in bad_values:
                    with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                        fanout.validate_config(dict(settings, **{field: value}))


class CoverageTests(unittest.TestCase):
    def test_failed_shard_can_prove_coverage_without_becoming_a_pass(self):
        artifact = report([1], 1)
        artifact['suites'][0]['specs'][0]['tests'][0].update(
            status='unexpected', results=[{'status': 'failed'}])
        result = {'source_commit': SHA, 'status': 'failed', 'browser_exit_code': 1,
                  'commands': [{'exit_code': 0}], 'error': 'RuntimeError: browser tests exited 1'}
        self.assertEqual(len(fanout.verify_browser_report(artifact, SHA, result, 1, 20, allow_failure=True)), 1)
        with self.assertRaises(ValueError):
            fanout.verify_browser_report(artifact, SHA, result, 1, 20)
        for change in ('wrong-source', 'wrong-shard', 'global-error', 'interrupted'):
            candidate, metadata = copy.deepcopy(artifact), copy.deepcopy(result)
            if change == 'wrong-source':
                metadata['source_commit'] = 'b' * 40
            elif change == 'wrong-shard':
                candidate['config']['shard']['current'] = 2
            elif change == 'global-error':
                candidate['errors'] = [{'message': 'worker crashed'}]
            else:
                candidate['suites'][0]['specs'][0]['tests'][0]['results'] = [{'status': 'interrupted'}]
            with self.subTest(change=change), self.assertRaises(ValueError):
                fanout.verify_browser_report(candidate, SHA, metadata, 1, 20, allow_failure=True)

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


class DeferredRetryCoverageTests(unittest.TestCase):
    def first(self, indices=(1,)):
        value = report(indices, 1)
        value['suites'][0]['specs'][0]['tests'][0].update(
            status='unexpected', results=[{'status': 'failed', 'retry': 0, 'duration': 20}])
        return value

    def result(self, failed=False):
        return {'source_commit': SHA, 'status': 'failed' if failed else 'passed',
                'commands': [{'exit_code': 0}], 'browser_exit_code': 1 if failed else 0,
                **({'error': 'RuntimeError: browser tests exited 1'} if failed else {})}

    def test_recovered_test_is_flaky_and_both_attempts_are_retained(self):
        first = self.first((1, 2))
        original = copy.deepcopy(first)
        retry = report([1])
        first['stats'] = {'startTime': '2026-11-25T00:00:00Z', 'duration': 1000}
        original['stats'] = dict(first['stats'])
        retry['stats'] = {'startTime': '2026-11-25T00:01:00Z', 'duration': 2000}
        merged, recovered = fanout.merge_browser_retry(first, retry, self.result(), SHA)
        self.assertEqual(first, original)
        tests = [test for _, _, test in fanout.report_cases(merged)]
        self.assertEqual([test['status'] for test in tests], ['flaky', 'expected'])
        self.assertEqual([attempt['retry'] for attempt in tests[0]['results']], [0, 1])
        self.assertEqual(tests[0]['results'][1]['fanoutPhase'], 'browser-retry')
        self.assertEqual(tests[1], original['suites'][0]['specs'][1]['tests'][0])
        self.assertEqual(len(recovered), 1)
        self.assertEqual(merged['stats']['duration'], 62000)

    def test_persistent_failure_remains_red(self):
        first = self.first()
        retry = self.first()
        retry['config'].pop('shard')
        merged, recovered = fanout.merge_browser_retry(first, retry, self.result(True), SHA)
        self.assertEqual(recovered, [])
        self.assertEqual(fanout.browser_stats(merged)['unexpected'], 1)
        self.assertEqual(len(fanout.report_cases(merged)[0][2]['results']), 2)

    def test_retry_rejects_missing_extra_skipped_unrun_unknown_project_and_global_errors(self):
        for change in ('missing', 'extra', 'skipped', 'unrun', 'wrong-project', 'multi-project',
                       'sharded', 'expected-failure', 'interrupted', 'immediate-retry', 'global-error', 'source'):
            retry, result = report([1]), self.result()
            test = retry['suites'][0]['specs'][0]['tests'][0]
            if change == 'missing':
                retry['suites'][0]['specs'] = []
            elif change == 'extra':
                retry = report([1, 2])
            elif change == 'skipped':
                test.update(status='skipped', expectedStatus='skipped', results=[{'status': 'skipped', 'retry': 0}])
            elif change == 'unrun':
                test['results'] = []
            elif change == 'wrong-project':
                test['projectName'] = 'firefox'
            elif change == 'multi-project':
                retry['config']['projects'].append({'name': 'firefox', 'retries': 0})
            elif change == 'sharded':
                retry['config']['shard'] = {'current': 1, 'total': 20}
            elif change == 'expected-failure':
                test['expectedStatus'] = 'failed'
            elif change == 'interrupted':
                test['results'][0]['status'] = 'interrupted'
            elif change == 'immediate-retry':
                test['results'].append({'status': 'passed', 'retry': 1})
            elif change == 'global-error':
                retry['errors'] = [{'message': 'worker disappeared'}]
            else:
                result['source_commit'] = 'b' * 40
            with self.subTest(change=change), self.assertRaises(ValueError):
                fanout.merge_browser_retry(self.first(), retry, result, SHA)

    def test_unexpected_pass_and_blocked_cases_cannot_be_recovered(self):
        first = self.first((1, 2, 3, 4))
        tests = [test for _, _, test in fanout.report_cases(first)]
        tests[1].update(status='unexpected', expectedStatus='failed')
        tests[2].update(status='skipped', results=[])
        tests[3].update(status='skipped', expectedStatus='skipped', results=[{'status': 'skipped'}])
        self.assertEqual(list(fanout.failed_browser_cases(first).values()), ['case-1'])
        self.assertEqual(len(fanout.unrun_browser_cases(first)), 1)
        merged, _ = fanout.merge_browser_retry(first, report([1]), self.result(), SHA)
        self.assertEqual(fanout.browser_stats(merged), {'expected': 0, 'flaky': 1, 'unexpected': 1, 'skipped': 2})
        self.assertEqual(len(fanout.unrun_browser_cases(merged)), 1)


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

    def test_artifact_transfer_cap_does_not_extend_deadline_or_bypass_normal_stop(self):
        self.initialize()
        deadline = (fanout.utcnow() + dt.timedelta(hours=1)).isoformat()
        self.controller.update(lambda state: state.update(deadline=deadline))
        self.assertEqual(self.controller.artifact_transfer_timeout(), 900)
        shorter = (fanout.utcnow() + dt.timedelta(seconds=30)).isoformat()
        self.controller.update(lambda state: state.update(deadline=shorter))
        self.assertGreater(self.controller.artifact_transfer_timeout(), 0)
        self.assertLessEqual(self.controller.artifact_transfer_timeout(), 30)
        self.controller.update(lambda state: state.update(stop_requested=True))
        with self.assertRaisesRegex(RuntimeError, 'stop requested'):
            self.controller.artifact_transfer_timeout()
        self.assertLessEqual(self.controller.artifact_transfer_timeout(allow_stopped=True), 30)
        self.assertEqual(self.controller.read()['deadline'], shorter)
        self.controller.update(lambda state: state.update(deadline=(fanout.utcnow() - dt.timedelta(seconds=1)).isoformat()))
        with self.assertRaisesRegex(TimeoutError, 'deadline reached'):
            self.controller.artifact_transfer_timeout(allow_stopped=True)

    def test_restore_rechecks_remaining_budget_between_payload_and_publication(self):
        self.controller.config['artifact_archive_dir'] = str(self.root / 'archives')
        self.initialize()
        archive = self.root / 'archives' / (SHA + '-fixture')
        archive.mkdir(parents=True)
        prepared_bundle(archive / 'bundle')
        receipt = {'version': 1, 'source_commit': SHA, 'build_exit_code': 0,
                   'manifest_sha256': fanout.file_sha256(archive / 'bundle/manifest.json')}
        (archive / 'build-receipt.json').write_text(json.dumps(receipt))
        (archive / 'COMPLETED').write_text(fanout.file_sha256(archive / 'build-receipt.json'))
        self.controller.update(lambda state: state.update(deadline=(fanout.utcnow() + dt.timedelta(hours=1)).isoformat()))
        def upload(node_id, files, destination, timeout):
            self.assertEqual(timeout, 900)
            self.assertEqual(len(files), len(fanout.BUNDLE_FILES))
            self.controller.update(lambda state: state.update(deadline=(fanout.utcnow() - dt.timedelta(seconds=1)).isoformat()))
        with mock.patch.object(self.controller, 'ssh', return_value='') as ssh, \
             mock.patch.object(self.controller, 'scp', side_effect=upload) as scp:
            with self.assertRaisesRegex(TimeoutError, 'deadline reached'):
                fanout.Controller.restore_bundle(self.controller, 'node-001')
        self.assertEqual(scp.call_count, 1)
        self.assertEqual(ssh.call_count, 1)
        self.assertNotIn('restored_bundle_archive', self.controller.read()['nodes']['node-001'])

    def test_phase_transport_preserves_explicit_resource_widths(self):
        self.controller.config.update(build_jobs=64, rust_test_threads=48, workers=16,
                                      test_run_key='clone-one', cache_namespace='warm-seed')
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
        self.assertEqual((phase['test_run_key'], phase['cache_namespace']), ('clone-one', 'warm-seed'))

    def test_shared_check_generator_remains_lazy_and_finite_queues_prioritize_independent_checks(self):
        self.initialize()
        def jobs():
            yield ('js-lint', ['js-lint'])
            self.assertIn(('node-001', 'check-js-lint'), self.controller.events)
            yield ('rust-fmt', ['rust-fmt'])
        self.controller.run_check_queue('node-001', jobs())
        self.controller.read_bundle('node-001')
        self.controller.run_check_queue('node-001', [('js-test', ['js-test']), ('rust-clippy', ['rust-clippy'])])
        self.assertLess(self.controller.events.index(('node-001', 'check-rust-clippy')),
                        self.controller.events.index(('node-001', 'check-js-test')))

    def test_bundle_check_readiness_waits_and_wrong_source_cannot_fall_back_to_a_build(self):
        self.initialize()
        with mock.patch.object(fanout.time, 'sleep', side_effect=lambda _: self.controller.read_bundle('node-001')) as sleep:
            args = self.controller.bundle_check_args('node-001', 'js-test-integration')
        sleep.assert_called_once_with(1)
        self.assertEqual(args[:3], ['bundle-check', '--bundle', '/opt/atomic-ci/share/bundle'])
        self.assertEqual(args[args.index('--check-name') + 1], 'js-test-integration')
        self.controller.node_update('node-001', prepared_bundle={'path': '/wrong', 'source_commit': 'b' * 40,
                                   'manifest_sha256': 'b' * 64})
        with self.assertRaisesRegex(ValueError, 'pinned source'):
            self.controller.run_check_queue('node-001', [('js-test', ['js-test'])])
        self.assertNotIn(('node-001', 'check-js-test'), self.controller.events)

    def test_dynamic_checks_overlap_the_build_and_all_four_shared_jobs_wait_for_verified_delivery(self):
        self.controller = FakeController(config(self.root, 4), self.api)
        independent = threading.Event()
        phase, wait = self.controller.phase, self.controller.wait
        shared_args = {}
        def record_phase(node_id, name, kind, args, **kwargs):
            if name.startswith('check-'):
                check = name.removeprefix('check-')
                if check in fanout.BUNDLE_CHECKS:
                    self.assertIn('prepared_bundle', self.controller.read()['nodes'][node_id])
                    self.assertEqual(args[0], 'bundle-check')
                    shared_args[check] = args
                else:
                    independent.set()
            return phase(node_id, name, kind, args, **kwargs)
        def wait_for_build(nodes):
            if nodes == ['node-001'] and self.controller.read()['nodes']['node-001'].get('phase') == 'build':
                self.assertTrue(independent.wait(5), 'independent checks did not start while the build was running')
            return wait(nodes)
        with mock.patch.object(self.controller, 'phase', side_effect=record_phase), \
             mock.patch.object(self.controller, 'wait', side_effect=wait_for_build), \
             mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            self.controller.run()
        self.assertEqual(set(shared_args), set(fanout.BUNDLE_CHECKS))
        checks = [event[1] for event in self.controller.events if isinstance(event, tuple)
                  and isinstance(event[1], str) and event[1].startswith('check-')]
        self.assertCountEqual(checks, ['check-' + name for name, _ in fanout.CHECKS])
        self.assertEqual(self.controller.read()['status'], 'passed')

    def test_twenty_four_workers_reach_both_browser_rounds_without_changing_the_default(self):
        self.assertEqual(self.controller.config['workers'], 1)
        self.controller.config['workers'] = 24
        self.initialize()
        self.controller.read_bundle('node-001')
        with mock.patch.object(self.controller, 'phase') as phase:
            self.controller.browser('node-001', 'node-001')
            first = phase.call_args.args[3]
            self.controller.browser_retry('node-001', 'node-001')
            retry = phase.call_args.args[3]
        for args in (first, retry):
            self.assertEqual(args[args.index('--playwright-workers') + 1], '24')

    def test_retry_budget_is_zero_or_one_and_first_pass_never_retries_immediately(self):
        for value in (2, -1, True, .5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fanout.validate_config(dict(self.controller.config, retries=value))
        self.initialize()
        self.controller.read_bundle('node-001')
        self.controller.browser('node-001', 'node-001')
        # Inspect the actual browser scheduler's args, independently of its fake phase executor.
        with mock.patch.object(self.controller, 'phase') as phase:
            self.controller.browser('node-001', 'node-001')
        args = phase.call_args.args[3]
        self.assertEqual(args[args.index('--playwright-retries') + 1], '0')

    def test_final_retry_runs_after_every_first_pass_and_recovers_without_erasing_first_failure(self):
        self.controller.fail_browser_nodes = {'node-002'}
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            self.controller.run()
        state = self.controller.read()
        self.assertEqual(state['status'], 'passed')
        self.assertEqual(state['browser_result_stats'], {'expected': 19, 'flaky': 1, 'unexpected': 0, 'skipped': 0})
        self.assertEqual(state['ci_failures'][0]['phase'], 'browser')
        self.assertEqual(state['unresolved_ci_failures'], [])
        self.assertEqual(len(state['browser_flaky_identities']), 1)
        self.assertEqual(state['browser_retry_nodes'], ['node-002'])
        self.assertEqual([event for event in self.controller.events if isinstance(event, tuple) and event[0] == 'retry-barrier'],
                         [('retry-barrier', 20)])
        phases = [event for event in self.controller.events if isinstance(event, tuple) and event[1] == 'browser-retry']
        self.assertEqual(phases, [('node-002', 'browser-retry')])
        self.assertTrue(Path(state['browser_merged_report_path']).is_file())
        before = list(self.controller.events)
        self.controller.finish_validation(list(state['nodes']))
        self.assertEqual(self.controller.events, before)

    def test_nonbrowser_failure_stays_red_even_when_all_browser_failures_recover(self):
        self.controller.fail_browser_nodes = {'node-002'}
        self.controller.fail_checks = {'check-rust-fmt'}
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaises(fanout.CIValidationFailure):
                self.controller.run()
        state = self.controller.read()
        self.assertEqual(state['browser_result_stats']['flaky'], 1)
        self.assertEqual([failure['phase'] for failure in state['unresolved_ci_failures']], ['check-rust-fmt'])
        self.assertNotIn('validation_passed_at', state)

    def test_persistent_retry_failure_and_disabled_retry_keep_failures_visible(self):
        for retries in (0, 1):
            with self.subTest(retries=retries), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root / 'probe').mkdir()
                (root / 'probe/dagger.json').write_text('{}')
                settings = config(root, 4)
                settings['retries'] = retries
                controller = FakeController(settings, FakeAPI())
                controller.fail_browser_nodes = {'node-002'}
                controller.fail_retry_nodes = {'node-002'}
                with mock.patch.object(fanout.subprocess, 'Popen') as process:
                    process.return_value.poll.return_value = 0
                    process.return_value.pid = 12345
                    with self.assertRaises(fanout.CIValidationFailure):
                        controller.run()
                state = controller.read()
                self.assertEqual(state['browser_result_stats']['unexpected'], 1)
                self.assertEqual(len(state['browser_remaining_failed_identities']), 1)
                self.assertEqual(state['browser_retry_nodes'], ['node-002'] if retries else [])
                self.assertTrue(all(node.get('deletion_verified') for node in state['nodes'].values()))

    def test_retry_global_errors_are_fatal_and_cleanup_still_runs(self):
        self.controller.fail_browser_nodes = {'node-002'}
        self.controller.retry_global_error = True
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'global errors'):
                self.controller.run()
        state = self.controller.read()
        self.assertNotIn('validation_passed_at', state)
        self.assertTrue(all(node.get('deletion_verified') for node in state['nodes'].values()))

    def test_corrupt_first_receipt_stops_before_retry_execution(self):
        self.controller.fail_browser_nodes = {'node-002'}
        original = self.controller.verify_browser
        def corrupt(node_id, allow_failure=False):
            result = original(node_id, allow_failure)
            if node_id == 'node-002':
                path = self.controller.root / node_id / 'results/browser/browser/browser-run.json'
                receipt = json.loads(path.read_text())
                receipt['manifestSha256'] = 'c' * 64
                path.write_text(json.dumps(receipt))
            return result
        with mock.patch.object(self.controller, 'verify_browser', side_effect=corrupt), \
             mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'receipt identity'):
                self.controller.run()
        self.assertFalse(any(isinstance(event, tuple) and event[1] == 'browser-retry' for event in self.controller.events))
        self.assertTrue(all(node.get('deletion_verified') for node in self.controller.read()['nodes'].values()))

    def test_unknown_retry_selection_receipt_cannot_approve_recovery(self):
        self.controller.fail_browser_nodes = {'node-002'}
        self.controller.retry_selection_patch = {'failedTestIds': ['case-2', 'case-unknown']}
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'selection receipt'):
                self.controller.run()
        self.assertNotIn('validation_passed_at', self.controller.read())

    def test_deadline_at_barrier_prevents_final_retry_launch_and_keeps_cleanup(self):
        self.controller.fail_browser_nodes = {'node-002'}
        original = self.controller.validate_first_pass
        def expire(nodes):
            value = original(nodes)
            self.controller.update(lambda state: state.update(deadline=(fanout.utcnow() - dt.timedelta(seconds=1)).isoformat()))
            return value
        with mock.patch.object(self.controller, 'validate_first_pass', side_effect=expire), \
             mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaises(TimeoutError):
                self.controller.run()
        state = self.controller.read()
        self.assertIn('first_pass_completed_at', state)
        self.assertNotIn('browser_retry_started_at', state)
        self.assertNotIn('validation_passed_at', state)
        self.assertTrue(all(node.get('deletion_verified') for node in state['nodes'].values()))

    def test_only_completed_identical_check_results_are_recoverable(self):
        self.initialize()
        node_id = 'node-001'
        self.controller.node_update(node_id, phase='check-js-lint', phase_kind='check', status='running')
        result = {'batch_key': self.controller.config['batch_key'], 'source_commit': SHA,
                  'node_id': node_id, 'phase': 'check-js-lint', 'status': 'failed',
                  'commands': [{'exit_code': 1}], 'error': 'RuntimeError: phase command exited 1'}
        with mock.patch.object(self.controller, 'ssh', return_value=json.dumps(result)):
            with self.assertRaises(fanout.PhaseFailure):
                fanout.Controller.observe(self.controller, node_id)
        self.assertEqual(self.controller.read()['nodes'][node_id]['status'], 'waiting')
        for change in ('source', 'cancelled', 'identity-error', 'no-command', 'preflight'):
            candidate = copy.deepcopy(result)
            if change == 'source':
                candidate['source_commit'] = 'b' * 40
            elif change == 'cancelled':
                candidate['status'] = 'cancelled'
            elif change == 'identity-error':
                candidate['error'] = 'ValueError: phase source identity differs from clean pinned checkout'
            elif change == 'no-command':
                candidate['commands'] = []
            else:
                candidate['phase'] = 'source-preflight'
                self.controller.node_update(node_id, phase='source-preflight')
            with self.subTest(change=change), mock.patch.object(self.controller, 'ssh', return_value=json.dumps(candidate)):
                try:
                    fanout.Controller.observe(self.controller, node_id)
                except fanout.PhaseFailure:
                    self.fail('infrastructure/provenance failure was treated as a completed check')
                except (ValueError, RuntimeError):
                    pass
                else:
                    self.fail('invalid phase unexpectedly passed')

    def test_failed_check_does_not_skip_later_jobs_in_its_queue(self):
        self.initialize()
        self.controller.fail_checks = {'check-js-lint'}
        self.controller.run_check_queue('node-001', [('js-lint', ['js-lint']), ('rust-fmt', ['rust-fmt'])])
        state = self.controller.read()
        self.assertIn(('node-001', 'check-rust-fmt'), self.controller.events)
        self.assertEqual(state['ci_failures'][0]['phase'], 'check-js-lint')
        self.assertEqual(state['nodes']['node-001']['phase_results']['check-rust-fmt']['status'], 'passed')

    def test_deadline_still_aborts_a_check_queue(self):
        self.initialize()
        self.controller.update(lambda state: state.update(deadline=(fanout.utcnow() - dt.timedelta(seconds=1)).isoformat()))
        with self.assertRaises(TimeoutError):
            self.controller.run_check_queue('node-001', [('js-lint', ['js-lint']), ('rust-fmt', ['rust-fmt'])])
        self.assertNotIn(('node-001', 'check-rust-fmt'), self.controller.events)

    def test_final_validation_rejects_missing_and_unfinished_checks(self):
        self.initialize()
        self.controller.read_bundle('node-001')
        self.controller.run_check_queue('node-001', fanout.CHECKS[:-1])
        with self.assertRaisesRegex(ValueError, 'exactly once'):
            self.controller.finish_validation(list(self.controller.read()['nodes']))
        self.controller.run_check_queue('node-001', fanout.CHECKS[-1:])
        self.controller.update(lambda state: state['nodes']['node-001']['phase_results']['check-js-lint'].update(status='running'))
        with self.assertRaisesRegex(ValueError, 'not complete'):
            self.controller.finish_validation(list(self.controller.read()['nodes']))
        self.controller.update(lambda state: state['nodes']['node-001']['phase_results']['check-js-lint'].update(status='failed'))
        with self.assertRaisesRegex(ValueError, 'not collected'):
            self.controller.finish_validation(list(self.controller.read()['nodes']))
        self.assertNotIn('validation_passed_at', self.controller.read())
        self.assertNotIn('validation_completed_at', self.controller.read())

    def test_failed_browser_retains_stats_and_identities_without_pass_timestamp(self):
        self.initialize()
        node_id = 'node-001'
        result = {'source_commit': SHA, 'status': 'failed', 'browser_exit_code': 1,
                  'commands': [{'exit_code': 0}], 'error': 'RuntimeError: browser tests exited 1'}
        self.controller.update(lambda state: state['nodes'][node_id]['phase_results'].update(browser=result))
        artifact = report([1], 1)
        artifact['stats'] = {'expected': 0, 'unexpected': 1}
        artifact['suites'][0]['specs'][0]['tests'][0].update(status='unexpected', results=[{'status': 'failed'}])
        local = self.root / 'download'
        (local / 'results/browser/browser').mkdir(parents=True)
        (local / 'results/browser/result.json').write_text(json.dumps(result))
        (local / 'results/browser/browser/test-results.json').write_text(json.dumps(artifact))
        with mock.patch.object(self.controller, 'retrieve', return_value=local):
            identities = fanout.Controller.verify_browser(self.controller, node_id, allow_failure=True)
        node = self.controller.read()['nodes'][node_id]
        self.assertEqual(len(identities), 1)
        self.assertEqual(node['browser_stats'], artifact['stats'])
        self.assertFalse(node['browser_passed'])
        self.assertIsNone(node['browser_verified_at'])
        self.assertIn('browser_completed_at', node)

    def test_check_and_canary_test_failures_finish_every_check_and_browser_shard_before_aggregate_failure(self):
        self.controller.fail_checks = {'check-js-lint'}
        self.controller.fail_browser_nodes = {'node-002'}
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaises(fanout.CIValidationFailure):
                self.controller.run()
        state = self.controller.read()
        self.assertEqual(state['full_browser_test_count'], 20)
        self.assertIn('validation_completed_at', state)
        self.assertNotIn('validation_passed_at', state)
        self.assertCountEqual([failure['phase'] for failure in state['ci_failures']],
                              ['browser', 'check-js-lint'])
        browser_failure = next(failure for failure in state['ci_failures'] if failure['phase'] == 'browser')
        lint_failure = next(failure for failure in state['ci_failures'] if failure['phase'] == 'check-js-lint')
        self.assertEqual(browser_failure['node_id'], 'node-002')
        lint_owners = [event[0] for event in self.controller.events
                       if isinstance(event, tuple) and event[1] == 'check-js-lint']
        self.assertEqual(lint_owners, [lint_failure['node_id']])
        self.assertEqual(state['nodes'][lint_failure['node_id']]['phase_results']['check-js-lint']['status'], 'failed')
        self.assertEqual([failure['phase'] for failure in state['unresolved_ci_failures']], ['check-js-lint'])
        phases = [item[1] for item in self.controller.events if isinstance(item, tuple)
                  and isinstance(item[1], str) and item[1].startswith('check-')]
        self.assertCountEqual(phases, ['check-' + name for name, _ in fanout.CHECKS])
        browsers = [item[0] for item in self.controller.events if isinstance(item, tuple) and item[1] == 'browser']
        self.assertEqual(len(set(browsers)), 20)
        self.assertEqual(state['status'], 'stopped')
        self.assertTrue(all(node.get('deletion_verified') for node in state['nodes'].values()))

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

    def test_late_visible_lost_create_keeps_evidence_and_watchdog_removes_it_after_deadline(self):
        self.initialize()
        for name in ('operator-key', 'doctl.yaml'):
            (self.controller.root / name).write_text('fixture')
        self.controller.create('node-011')
        self.api.hidden_droplets.add('default')
        self.api.lose_create = True
        with self.assertRaises(TimeoutError):
            self.controller.create('node-001')
        deadline = self.controller.read()['deadline']
        with self.assertRaisesRegex(RuntimeError, 'pending provider reconciliation'):
            self.controller.cleanup('lost response')
        state = self.controller.read()
        self.assertIsNone(state['finished_at'])
        self.assertEqual(state['status'], 'cleanup_failed')
        self.assertTrue(state['nodes']['node-011']['deletion_verified'])
        self.assertEqual(len(self.api.droplets['default']), 1)
        for name in ('operator-key', 'operator-key.pub', 'doctl.yaml'):
            self.assertTrue((self.controller.root / name).exists())
        # Cleanup is allowed after the original deadline, but no new work is.
        self.api.hidden_droplets.clear()
        later = dt.datetime.fromisoformat(deadline) + dt.timedelta(seconds=1)
        with mock.patch.object(fanout, 'utcnow', return_value=later):
            self.assertTrue(self.controller.watchdog_step())
        state = self.controller.read()
        self.assertEqual(state['deadline'], deadline)
        self.assertTrue(state['nodes']['node-001']['deletion_verified'])
        self.assertTrue(state['finished_at'])
        self.assertEqual(self.api.droplets['default'], [])
        self.assertFalse((self.controller.root / 'doctl.yaml').exists())

    def test_known_create_hidden_before_delete_remains_pending_until_visible(self):
        self.initialize()
        self.controller.create('node-001')
        self.api.hidden_droplets.add('default')
        with self.assertRaisesRegex(RuntimeError, 'absence pending provider reconciliation'):
            self.controller.cleanup('bootstrap failure before list visibility')
        node = self.controller.read()['nodes']['node-001']
        self.assertNotIn('deleted_at', node)
        self.assertIsNone(self.controller.read()['finished_at'])
        self.assertEqual(len(self.api.droplets['default']), 1)
        self.api.hidden_droplets.clear()
        self.assertTrue(self.controller.watchdog_step())
        self.assertEqual(self.api.droplets['default'], [])
        self.assertTrue(self.controller.read()['nodes']['node-001']['deletion_verified'])

    def test_unknown_absent_create_requires_fresh_list_after_reconciliation_grace(self):
        self.initialize()
        self.api.lose_create = True
        self.api.hidden_droplets.add('default')
        with self.assertRaises(TimeoutError):
            self.controller.create('node-001')
        # The provider eventually confirms it never retained a resource.
        self.api.droplets['default'].clear()
        with self.assertRaisesRegex(RuntimeError, 'pending provider reconciliation'):
            self.controller.cleanup('unknown outcome')
        attempted = dt.datetime.fromisoformat(self.controller.read()['nodes']['node-001']['creation_attempted_at'])
        with mock.patch.object(fanout, 'utcnow', return_value=attempted + dt.timedelta(seconds=119)):
            with self.assertRaisesRegex(RuntimeError, 'pending provider reconciliation'):
                self.controller.watchdog_step()
        with mock.patch.object(fanout, 'utcnow', return_value=attempted + dt.timedelta(seconds=121)):
            self.assertTrue(self.controller.watchdog_step())
        node = self.controller.read()['nodes']['node-001']
        self.assertTrue(node['creation_absence_reconciled_at'])
        self.assertNotIn('droplet_id', node)

    def test_lost_key_import_retains_public_key_until_late_key_is_deleted(self):
        self.controller.initialize(self.controller.plan())
        self.api.hidden_keys.add('default')
        self.api.lose_import = True
        with self.assertRaises(TimeoutError):
            self.controller.register_keys()
        with self.assertRaisesRegex(RuntimeError, 'SSH key import outcome pending'):
            self.controller.cleanup('lost key response')
        self.assertIsNone(self.controller.read()['finished_at'])
        self.assertTrue((self.controller.root / 'operator-key.pub').exists())
        self.assertEqual(len(self.api.keys['default']), 1)
        self.api.hidden_keys.clear()
        self.assertTrue(self.controller.watchdog_step())
        self.assertEqual(self.api.keys['default'], [])
        self.assertFalse((self.controller.root / 'operator-key.pub').exists())

    def test_unknown_absent_key_import_requires_fresh_list_after_grace(self):
        self.controller.initialize(self.controller.plan())
        self.api.hidden_keys.add('default')
        self.api.lose_import = True
        with self.assertRaises(TimeoutError):
            self.controller.register_keys()
        self.api.keys['default'].clear()
        with self.assertRaisesRegex(RuntimeError, 'SSH key import outcome pending'):
            self.controller.cleanup('unknown import')
        attempted = dt.datetime.fromisoformat(self.controller.read()['keys']['default']['creation_attempted_at'])
        with mock.patch.object(fanout, 'utcnow', return_value=attempted + dt.timedelta(seconds=121)):
            self.assertTrue(self.controller.watchdog_step())
        self.assertTrue(self.controller.read()['keys']['default']['creation_absence_reconciled_at'])

    def test_known_key_hidden_before_delete_retains_cleanup_until_visible(self):
        self.initialize()
        self.api.hidden_keys.add('default')
        with self.assertRaisesRegex(RuntimeError, 'owned SSH key absence pending'):
            self.controller.cleanup('key list delayed')
        self.assertIsNone(self.controller.read()['finished_at'])
        self.assertFalse(self.controller.read()['keys']['default'].get('deletion_verified'))
        self.api.hidden_keys.clear()
        self.assertTrue(self.controller.watchdog_step())
        self.assertEqual(self.api.keys['default'], [])

    def test_preexisting_names_and_old_same_name_resources_are_not_adopted(self):
        self.initialize()
        name = self.controller.read()['nodes']['node-001']['name']
        foreign = {'id': 900, 'name': name, 'created_at': '2020-01-01T00:00:00+00:00'}
        self.api.droplets['default'].append(foreign)
        mutations = list(self.api.mutations)
        with self.assertRaisesRegex(RuntimeError, 'pre-existing Droplet'):
            self.controller.create('node-001')
        self.assertEqual(mutations, self.api.mutations)
        self.api.droplets['default'].clear()
        self.api.hidden_droplets.add('default')
        self.api.lose_create = True
        with self.assertRaises(TimeoutError):
            self.controller.create('node-001')
        # An unrelated old same-name resource is never sufficient ownership.
        self.api.droplets['default'][:] = [foreign]
        self.api.hidden_droplets.clear()
        with self.assertRaisesRegex(RuntimeError, 'lacks verified creation ownership'):
            self.controller.cleanup('foreign same-name resource')
        self.assertEqual(self.api.droplets['default'], [foreign])
        self.assertIsNone(self.controller.read()['finished_at'])

    def test_watchdog_survives_cleanup_error_and_retries_until_verified(self):
        self.initialize()
        self.controller.update(lambda state: state.update(stop_requested=True))
        step = self.controller.watchdog_step
        calls = []
        def delayed_cleanup():
            calls.append(True)
            if len(calls) == 1:
                raise RuntimeError('temporary provider list failure')
            return step()
        with mock.patch.object(self.controller, 'watchdog_step', side_effect=delayed_cleanup), mock.patch.object(fanout.time, 'sleep'):
            self.controller.watchdog()
        self.assertEqual(len(calls), 2)
        self.assertTrue(self.controller.read()['finished_at'])

    def test_run_leaves_watchdog_alive_when_lost_create_cleanup_is_pending(self):
        self.api.hidden_droplets.add('default')
        self.api.lose_create = True
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = None
            process.return_value.pid = 12345
            with self.assertRaisesRegex(RuntimeError, 'cleanup incomplete'):
                self.controller.run()
            process.return_value.terminate.assert_not_called()
            process.return_value.kill.assert_not_called()
        self.assertIsNone(self.controller.read()['finished_at'])
        self.api.hidden_droplets.clear()
        self.assertTrue(self.controller.watchdog_step())
        self.assertEqual(sum(map(len, self.api.droplets.values())), 0)

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
        manifest = {'version': 2, 'sourceCommit':SHA, 'platform':'linux/amd64',
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
