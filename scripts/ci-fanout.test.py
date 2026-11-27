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


class CommandErrorTests(unittest.TestCase):
    def failure(self, stdout, stderr='', args=None):
        command = args or ['doctl', '--access-token', 'ARGUMENT_SECRET', 'compute', 'droplet', 'get', '0']
        result = subprocess.CompletedProcess(command, 1, stdout=stdout, stderr=stderr)
        with mock.patch.object(fanout.subprocess, 'run', return_value=result):
            with self.assertRaises(RuntimeError) as raised:
                fanout.execute(command, text=isinstance(stdout, str))
        return str(raised.exception)

    def test_doctl_json_error_uses_only_structured_details_and_exit_code(self):
        error = self.failure(json.dumps({'errors': [{
            'code': 'invalid_argument',
            'detail': 'dropletID is invalid because cannot be less than 1',
            'next_step': 'run doctl compute droplet get --help',
            'access_token': 'OUTPUT_SECRET',
        }], 'credentials': 'DOCUMENT_SECRET'}))
        self.assertIn('exit 1', error)
        self.assertIn('invalid_argument', error)
        self.assertIn('dropletID is invalid because cannot be less than 1', error)
        for excluded in ('next_step', '--help', 'ARGUMENT_SECRET', 'OUTPUT_SECRET', 'DOCUMENT_SECRET'):
            self.assertNotIn(excluded, error)

    def test_normal_stderr_stays_authoritative_for_text_and_bytes(self):
        for binary in (False, True):
            with self.subTest(binary=binary):
                stderr = b'normal stderr failure' if binary else 'normal stderr failure'
                stdout = b'{"errors":[{"detail":"stdout diagnostic"}]}' if binary else '{"errors":[{"detail":"stdout diagnostic"}]}'
                error = self.failure(stdout, stderr)
                self.assertIn('normal stderr failure', error)
                self.assertIn('exit 1', error)
                self.assertNotIn('stdout diagnostic', error)

    def test_nonerror_or_malformed_stdout_is_never_dumped(self):
        for stdout in ('SECRET malformed JSON', '{"token":"SECRET"}',
                       '{"errors":"SECRET"}', '{"errors":[null, {"token":"SECRET"}]}',
                       '{"errors":[{"detail":{"token":"SECRET"}}]}'):
            with self.subTest(stdout=stdout):
                error = self.failure(stdout)
                self.assertIn('exit 1', error)
                self.assertNotIn('SECRET', error)
                self.assertNotIn('ARGUMENT_SECRET', error)

    def test_doctl_structured_error_supports_bytes_but_other_programs_do_not_parse_stdout(self):
        output = b'{"errors":[{"detail":"safe provider diagnostic"}]}'
        self.assertIn('safe provider diagnostic', self.failure(output, b'', ['/usr/local/bin/doctl']))
        self.assertNotIn('safe provider diagnostic', self.failure(output, b'', ['other-program']))

    def test_cancellable_command_reaps_its_child_on_cancel_and_timeout(self):
        for timed_out in (False, True):
            with self.subTest(timed_out=timed_out), tempfile.TemporaryDirectory() as temp:
                pid_path = Path(temp) / 'pid'
                def cancel():
                    if pid_path.exists() and not timed_out:
                        raise fanout.cf.CancelledError('backup cancelled')
                script = 'import os,time,pathlib; pathlib.Path(' + repr(str(pid_path)) + ').write_text(str(os.getpid())); time.sleep(5)'
                failure = subprocess.TimeoutExpired if timed_out else fanout.cf.CancelledError
                with self.assertRaises(failure):
                    fanout.execute([fanout.sys.executable, '-c', script], timeout=.25, cancel=cancel)
                self.assertTrue(pid_path.exists())
                with self.assertRaises(ProcessLookupError):
                    fanout.os.kill(int(pid_path.read_text()), 0)

    def test_cancellable_command_kills_grandchild_inheriting_transfer_pipes(self):
        # Like scp -> ssh: the grandchild inherits stdout/stderr, so killing
        # only the immediate child would leave communicate() waiting for EOF.
        for timed_out in (False, True):
            with self.subTest(timed_out=timed_out), tempfile.TemporaryDirectory() as temp:
                pid_path = Path(temp) / 'pids'
                def cancel():
                    if pid_path.exists() and not timed_out:
                        raise fanout.cf.CancelledError('backup cancelled')
                script = ('import os,pathlib,subprocess,sys,time; '
                          'grandchild=subprocess.Popen([sys.executable,"-c","import time; time.sleep(3)"]); '
                          'pathlib.Path(' + repr(str(pid_path)) + ').write_text(str(os.getpid())+" "+str(grandchild.pid)); '
                          'time.sleep(3)')
                began = fanout.time.monotonic()
                failure = subprocess.TimeoutExpired if timed_out else fanout.cf.CancelledError
                with self.assertRaises(failure):
                    fanout.execute([fanout.sys.executable, '-c', script], timeout=.5, cancel=cancel)
                self.assertLess(fanout.time.monotonic() - began, 2)
                self.assertTrue(pid_path.exists())
                for pid in map(int, pid_path.read_text().split()):
                    status = ''
                    for _ in range(20):
                        observed = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
                        status = observed.stdout.strip()
                        if not status or status.startswith('Z'):
                            break
                        fanout.time.sleep(.025)
                    self.assertTrue(not status or status.startswith('Z'), f'owned transfer process {pid} still running: {status}')

    def test_success_still_returns_original_stdout_without_parsing(self):
        result = subprocess.CompletedProcess(['doctl'], 0, stdout=b'original output', stderr=b'')
        with mock.patch.object(fanout.subprocess, 'run', return_value=result):
            self.assertEqual(fanout.execute(['doctl']), b'original output')


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
        self.global_browser_reports = {}
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

    def prepare_dagger_api(self, node_id):
        self.events.append(('api-prepared', node_id))

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
        return self.root / 'fake-validated-archive'

    def restore_bundle(self, builder):
        self.events.append(('restore', builder))

    def phase(self, node_id, name, kind, args, preflight=False, module=None):
        self.check_deadline()
        result = {'batch_key': self.config['batch_key'], 'node_id': node_id, 'phase': name,
                  'source_commit': SHA, 'status': 'passed', 'browser_exit_code': 0,
                  'commands': [{'exit_code': 0}], 'finished_at': fanout.stamp()}
        self.node_update(node_id, status='waiting', phase=name, phase_kind=kind,
                         last_result=result)
        self.update(lambda state: state['nodes'][node_id]['phase_results'].update({name: result}))
        self.events.append((node_id, name))

    def wait(self, nodes):
        self.check_deadline()
        for key in nodes:
            node = self.read()['nodes'][key]
            if node.get('phase') == 'browser' and key in self.global_browser_reports:
                result = dict(node['last_result'], status='failed', browser_exit_code=1,
                    failure_scope='completed-export-browser-global', error='RuntimeError: browser report contains global errors')
                self.update(lambda state: state['nodes'][key]['phase_results'].update(browser=result))
                self.node_update(key, last_result=result)
                raise fanout.PhaseFailure(key, 'browser', result)
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
        for key, value in self.global_browser_reports.items():
            index = self.read()['nodes'][key]['shard_index']
            specs = bundle['inventory']['suites'][0]['specs']
            specs[:] = [item for item in specs if item['id'] != 'case-' + str(index)]
            specs.extend(copy.deepcopy(value['suites'][0]['specs']))
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
        if node_id in self.global_browser_reports:
            self.write_browser_export(node_id, 'browser', self.global_browser_reports[node_id])
            return fanout.Controller.verify_browser(self, node_id, allow_failure)
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
        unrun = set(fanout.unrun_browser_cases(value))
        ids = [spec['id'] for identity, spec, test in fanout.report_cases(value)
               if test['status'] == 'unexpected' or identity in unrun]
        (root / 'browser/test-results/.last-run.json').write_text(json.dumps({'status': 'failed' if ids or value.get('errors') else 'passed', 'failedTests': ids}))
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
        if node.get('phase', '').startswith('check-'):
            result = self.root / node_id / 'results' / node['phase'] / 'result.json'
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_text(json.dumps(node['phase_results'][node['phase']]))
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


def completed_global_report(index, total, start=1000):
    value = report(range(start, start + 131), index, total)
    for spec in value['suites'][0]['specs'][-2:]:
        spec['tests'][0].update(status='skipped', expectedStatus='skipped',
                                results=[{'status': 'skipped', 'retry': 0}])
    value['errors'] = [{'message': 'route.fetch: Test ended', 'stack': 'after test cleanup'}]
    value['stats'] = dict(expected=129, unexpected=0, skipped=2, flaky=0)
    return value


class CompletedGlobalBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.controller = FakeController(config(self.root, 4), FakeAPI())
        self.controller.global_browser_reports['node-002'] = completed_global_report(2, 4)
        (self.root / 'probe').mkdir()
        (self.root / 'probe/dagger.json').write_text('{}')

    def tearDown(self):
        self.temp.cleanup()

    def exported_global(self):
        ctl = self.controller
        ctl.initialize(ctl.plan())
        ctl.read_bundle('node-001')
        ctl.browser('node-002', 'node-001')
        with self.assertRaises(fanout.PhaseFailure):
            ctl.wait(['node-002'])
        value = copy.deepcopy(ctl.global_browser_reports['node-002'])
        ctl.write_browser_export('node-002', 'browser', value)
        return value

    def test_canary_and_other_global_shards_finish_all_checks_and_retry_only_ordinary_failure(self):
        ctl = self.controller
        ctl.global_browser_reports['node-003'] = completed_global_report(3, 4, 2000)
        global_with_test_failure = ctl.global_browser_reports['node-003']
        global_with_test_failure['suites'][0]['specs'][0]['tests'][0].update(
            status='unexpected', results=[{'status': 'failed', 'retry': 0}])
        global_with_test_failure['stats'].update(expected=128, unexpected=1)
        ctl.fail_browser_nodes = {'node-004'}
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaises(fanout.CIValidationFailure):
                ctl.run()
        state = ctl.read()
        checks = [phase for node in state['nodes'].values() for phase in node['phase_results'] if phase.startswith('check-')]
        self.assertEqual(sorted(checks), sorted('check-' + name for name, _ in fanout.CHECKS))
        self.assertTrue(all('browser' in node['phase_results'] for node in state['nodes'].values()))
        self.assertEqual(state['full_browser_test_count'], 264)
        self.assertEqual(state['browser_retry_nodes'], ['node-004'])
        self.assertEqual(state['browser_result_stats'], dict(expected=258, flaky=1, unexpected=1, skipped=4))
        self.assertEqual(len(state['browser_remaining_failed_identities']), 1)
        self.assertEqual({item['node_id'] for item in state['browser_global_errors']}, {'node-002', 'node-003'})
        self.assertEqual({item['node_id'] for item in state['unresolved_ci_failures']}, {'node-002', 'node-003'})
        self.assertTrue(all(item['failure_scope'] == 'completed-export-browser-global' for item in state['unresolved_ci_failures']))
        self.assertNotIn('validation_passed_at', state)
        self.assertTrue(all(node.get('deletion_verified') for node in state['nodes'].values()))
        merged = json.loads(Path(state['browser_merged_report_path']).read_text())
        self.assertEqual(len(merged['errors']), 2)
        self.assertEqual({error['fanout']['shard_index'] for error in merged['errors']}, {2, 3})
        self.assertTrue(all(error['fanout']['source_commit'] == SHA for error in merged['errors']))
        # A qualifying global canary is diagnostic coverage, never a passing phase.
        self.assertFalse(state['nodes']['node-002']['browser_passed'])
        self.assertIsNone(state['nodes']['node-002']['browser_verified_at'])
        self.assertIn(('source-inputs', ('node-002',)), ctl.events)
        self.assertEqual([event for event in ctl.events if isinstance(event, tuple) and event[0] == 'retry-barrier'],
                         [('retry-barrier', 4)])

    def test_global_qualification_rejects_missing_or_forged_evidence_and_nonterminal_coverage(self):
        variants = ('receipt-missing', 'receipt-source', 'receipt-hash', 'native-missing', 'native-last-run',
                    'invalid-json', 'source', 'scope', 'export', 'native-zero', 'shard', 'project', 'multi-project',
                    'unknown', 'native-id', 'duplicate', 'interrupted', 'unrun', 'blocked-native-missing',
                    'retry', 'counts', 'empty', 'no-global')
        for variant in variants:
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp:
                previous, root = self.controller, Path(temp)
                self.controller = FakeController(config(root, 4), FakeAPI())
                self.controller.global_browser_reports['node-002'] = completed_global_report(2, 4)
                ctl = self.controller
                value = self.exported_global()
                test = value['suites'][0]['specs'][0]['tests'][0]
                result = copy.deepcopy(ctl.read()['nodes']['node-002']['phase_results']['browser'])
                if variant in ('source', 'scope', 'export', 'native-zero'):
                    if variant == 'source': result['source_commit'] = 'c' * 40
                    if variant == 'scope': result.pop('failure_scope')
                    if variant == 'export': result['commands'][0]['exit_code'] = 1
                    if variant == 'native-zero': result['browser_exit_code'] = 0
                    ctl.update(lambda state: state['nodes']['node-002']['phase_results'].update(browser=result))
                if variant == 'shard': value['config']['shard']['current'] = 3
                if variant == 'project': test['projectName'] = 'unknown'
                if variant == 'multi-project': value['config']['projects'].append({'name': 'other', 'retries': 0})
                if variant == 'unknown': value['suites'][0]['specs'][0]['line'] = 99999
                if variant == 'native-id': value['suites'][0]['specs'][0]['id'] = 'foreign'
                if variant == 'interrupted': test['results'][0]['status'] = 'interrupted'
                if variant == 'unrun': test['results'] = []
                if variant == 'blocked-native-missing': test.update(status='skipped', results=[{'status': 'skipped'}])
                if variant == 'retry': test['results'][0]['retry'] = 1
                if variant == 'counts': value['stats']['expected'] = 130
                if variant == 'empty': value['suites'] = []
                if variant == 'no-global': value['errors'] = []
                ctl.write_browser_export('node-002', 'browser', value)
                exported = ctl.root / 'node-002/results/browser/browser'
                receipt_path = exported / 'browser-run.json'
                if variant == 'duplicate':
                    value['suites'][0]['specs'].append(copy.deepcopy(value['suites'][0]['specs'][0]))
                    (exported / 'test-results.json').write_text(json.dumps(value))
                    receipt = json.loads(receipt_path.read_text())
                    receipt['reportSha256'] = fanout.file_sha256(exported / 'test-results.json')
                    receipt_path.write_text(json.dumps(receipt))
                if variant == 'receipt-missing': receipt_path.unlink()
                if variant == 'receipt-source':
                    receipt = json.loads(receipt_path.read_text()); receipt['sourceCommit'] = 'c' * 40
                    receipt_path.write_text(json.dumps(receipt))
                if variant == 'receipt-hash': (exported / 'test-results.json').write_text(json.dumps(dict(value, errors=[])))
                if variant == 'native-missing': (exported / 'test-exit-code').unlink()
                if variant == 'invalid-json': (exported / 'test-results.json').write_text('{invalid')
                if variant in ('native-last-run', 'blocked-native-missing'):
                    native = exported / 'test-results/.last-run.json'
                    native.write_text(json.dumps({'status': 'passed' if variant == 'native-last-run' else 'failed',
                                                  'failedTests': []}))
                    receipt = json.loads(receipt_path.read_text()); receipt['lastRunSha256'] = fanout.file_sha256(native)
                    receipt_path.write_text(json.dumps(receipt))
                with self.assertRaises((ValueError, RuntimeError, OSError)):
                    fanout.Controller.verify_browser(ctl, 'node-002', allow_failure=True)
                self.assertNotIn('browser_global_failure_verified_at', ctl.read()['nodes']['node-002'])
                self.controller = previous

    def test_actual_global_shape_keeps_blocked_native_skipped_case_unrun_while_other_jobs_finish(self):
        ctl = self.controller
        value = ctl.global_browser_reports['node-002']
        blocked_spec = value['suites'][0]['specs'][-2]
        # The collected 129-pass/2-native-skip report had one legitimate fixme
        # and one expected-pass test blocked after a global route.fetch error.
        blocked_spec['tests'][0].update(expectedStatus='passed', annotations=[],
            results=[{'status': 'skipped', 'retry': 0, 'duration': 0, 'errors': [], 'annotations': []}])
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaises(fanout.CIValidationFailure):
                ctl.run()
        state = ctl.read()
        checks = [phase for node in state['nodes'].values() for phase in node['phase_results'] if phase.startswith('check-')]
        self.assertEqual(sorted(checks), sorted('check-' + name for name, _ in fanout.CHECKS))
        self.assertTrue(all('browser' in node['phase_results'] for node in state['nodes'].values()))
        self.assertEqual(len(state['browser_unrun_identities']), 1)
        self.assertEqual(len(state['browser_intentional_skipped_identities']), 1)
        self.assertEqual(len(state['browser_global_errors']), 1)
        self.assertEqual(state['browser_retry_nodes'], [])
        self.assertEqual(state['browser_result_stats'], dict(expected=132, unexpected=0, flaky=0, skipped=2))
        node = state['nodes']['node-002']
        self.assertTrue(node['browser_global_has_unrun_cases'])
        self.assertEqual(node['browser_global_unrun_identities'], state['browser_unrun_identities'])
        native = json.loads((ctl.root / 'node-002/results/browser/browser/test-results/.last-run.json').read_text())
        self.assertEqual(native['failedTests'], [blocked_spec['id']])
        self.assertEqual([item['node_id'] for item in state['unresolved_ci_failures']], ['node-002'])
        self.assertNotIn('validation_passed_at', state)
        self.assertTrue(all(node.get('deletion_verified') for node in state['nodes'].values()))

    def test_observer_global_scope_is_only_a_candidate_until_independent_artifact_verification(self):
        self.exported_global()
        ctl = self.controller
        result = dict(ctl.read()['nodes']['node-002']['phase_results']['browser'],
                      batch_key=ctl.config['batch_key'], node_id='node-002', phase='browser')
        with mock.patch.object(ctl, 'ssh', return_value=json.dumps(result)):
            with self.assertRaises(fanout.PhaseFailure):
                fanout.Controller.observe(ctl, 'node-002')
        state = ctl.read()
        self.assertNotIn('ci_failures', state)
        self.assertNotIn('browser_global_failure_verified_at', state['nodes']['node-002'])
        # The same error without the narrow marker retains immediate fatal behavior.
        result.pop('failure_scope')
        with mock.patch.object(ctl, 'ssh', return_value=json.dumps(result)):
            with self.assertRaises(RuntimeError) as raised:
                fanout.Controller.observe(ctl, 'node-002')
        self.assertNotIsInstance(raised.exception, fanout.PhaseFailure)

    def test_global_qualification_never_bypasses_post_execution_source_or_deadline_failure(self):
        self.exported_global()
        for guard, error in (('source_inputs', ValueError('source fingerprint differs')),
                             ('check_deadline', TimeoutError('CI deadline reached'))):
            with self.subTest(guard=guard), mock.patch.object(self.controller, guard, side_effect=error):
                with self.assertRaises(type(error)):
                    fanout.Controller.verify_browser(self.controller, 'node-002', allow_failure=True)
                self.assertNotIn('browser_global_failure_verified_at', self.controller.read()['nodes']['node-002'])

    def test_native_global_errors_require_message_stack_or_thrown_value_without_requiring_a_stack(self):
        value = self.exported_global()
        state = self.controller.read()
        result = state['nodes']['node-002']['phase_results']['browser']
        for error, valid in (({'message': 'test ended'}, True), ({'stack': 'native stack'}, True),
                             ({'value': 'thrown primitive'}, True), ({}, False),
                             ('not an error object', False), (None, False),
                             ({'message': ' \n\t'}, False), ({'message': 42}, False)):
            with self.subTest(error=error):
                value['errors'] = [error]
                args = (value, state['bundle']['inventory'], SHA, result, 2, 4)
                if valid:
                    self.assertEqual(len(fanout.verify_exported_browser_global_report(*args)), 131)
                else:
                    with self.assertRaisesRegex(ValueError, 'malformed global errors'):
                        fanout.verify_exported_browser_global_report(*args)

    def test_missing_unlisted_case_stays_fatal_at_full_union_barrier(self):
        ctl = self.controller
        original = ctl.read_bundle
        def missing_case(builder):
            bundle = original(builder)
            ctl.global_browser_reports['node-002']['suites'][0]['specs'].pop()
            ctl.global_browser_reports['node-002']['stats']['skipped'] -= 1
            return bundle
        with mock.patch.object(ctl, 'read_bundle', side_effect=missing_case), \
             mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'exactly cover'):
                ctl.run()
        state = ctl.read()
        self.assertTrue(all('browser' in node['phase_results'] for node in state['nodes'].values()))
        self.assertNotIn('validation_passed_at', state)
        self.assertNotIn('browser_retry_started_at', state)


class RunnerResourceTests(unittest.TestCase):
    def test_completed_global_browser_scope_is_failed_and_requires_successful_export_source_and_native_exit(self):
        spec = importlib.util.spec_from_file_location('global_runner_fixture', Path(__file__).with_name('ci-fanout-runner.py'))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        for variant in ('complete', 'export-failed', 'source-changed', 'native-zero', 'native-missing', 'invalid-json', 'retry'):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                phase = 'browser-retry' if variant == 'retry' else 'browser'
                args = ['browser-retry'] if phase == 'browser-retry' else ['browser-shard', '--playwright-retries', '0']
                path = root / 'config.json'
                path.write_text(json.dumps(dict(batch_key='fixture', source_commit=SHA, node_id='node-001',
                    phase=phase, kind='browser', args=args)))
                def execute(command, directory, log):
                    exported = root / 'results' / phase / 'browser'
                    exported.mkdir()
                    (exported / 'test-results.json').write_text('invalid' if variant == 'invalid-json' else
                        json.dumps({'errors': [{'message': 'route.fetch: Test ended'}]}))
                    if variant != 'native-missing':
                        (exported / 'test-exit-code').write_text('0' if variant == 'native-zero' else '1')
                    return 1 if variant == 'export-failed' else 0
                identity = [None, ValueError('source changed')] if variant == 'source-changed' else None
                with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner, 'check_prepared_bundle'), \
                     mock.patch.object(runner, 'check_identity', side_effect=identity), \
                     mock.patch.object(runner, 'run', side_effect=execute):
                    self.assertEqual(runner.main(path), 1)
                value = json.loads((root / 'results' / phase / 'result.json').read_text())
                self.assertEqual(value['status'], 'failed')
                self.assertEqual(value.get('failure_scope'), 'completed-export-browser-global' if variant == 'complete' else None)

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

    def test_host_bundle_backup_is_boolean_and_disabled_by_default(self):
        with tempfile.TemporaryDirectory() as temp:
            settings = config(Path(temp), 4)
            self.assertIs(settings['host_bundle_backup'], False)
            self.assertIs(fanout.validate_config(dict(settings, host_bundle_backup=True))['host_bundle_backup'], True)
            for value in (None, 0, 1, 'false', [], {}):
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'host_bundle_backup'):
                    fanout.validate_config(dict(settings, host_bundle_backup=value))


class AbsoluteDeadlineTests(unittest.TestCase):
    def test_config_requires_a_timezone_aware_iso_deadline(self):
        with tempfile.TemporaryDirectory() as temp:
            settings = config(Path(temp), 2)
            for value in ('', None, 123, 'tomorrow', '2026-11-25', '2026-11-25T21:14:48'):
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'absolute_deadline'):
                    fanout.validate_config(dict(settings, absolute_deadline=value))
            for value in ('2026-11-25T21:14:48Z', '2026-11-25T22:14:48+01:00'):
                self.assertEqual(fanout.validate_config(dict(settings, absolute_deadline=value))['absolute_deadline'], value)

    def test_expired_plan_rejects_before_local_or_provider_commands(self):
        with tempfile.TemporaryDirectory() as temp:
            settings = dict(config(Path(temp), 2), absolute_deadline=(fanout.utcnow() - dt.timedelta(seconds=1)).isoformat())
            api = FakeAPI()
            controller = fanout.Controller(settings, api)
            with mock.patch.object(fanout, 'execute') as execute, mock.patch.object(api, 'identity') as identity:
                with self.assertRaisesRegex(TimeoutError, 'deadline'):
                    controller.plan()
            execute.assert_not_called()
            identity.assert_not_called()
            self.assertEqual(api.mutations, [])

    def test_expired_initialization_rejects_before_state_or_key_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            settings = dict(config(Path(temp), 2), absolute_deadline=(fanout.utcnow() - dt.timedelta(seconds=1)).isoformat())
            controller = fanout.Controller(settings, FakeAPI())
            with mock.patch.object(fanout, 'execute') as execute:
                with self.assertRaisesRegex(TimeoutError, 'deadline'):
                    controller.initialize({'dagger_version': '0.0.1'})
            execute.assert_not_called()
            self.assertFalse(controller.path.exists())

    def test_initialization_and_later_creates_never_extend_either_deadline(self):
        began = fanout.utcnow()
        for absolute_hours in (.5, 6):
            with self.subTest(absolute_hours=absolute_hours), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                settings = dict(config(root, 2), max_hours=4,
                                absolute_deadline=(began + dt.timedelta(hours=absolute_hours)).isoformat())
                (root / 'credentials').write_text('fake credentials')
                api = FakeAPI()
                controller = fanout.Controller(settings, api)
                controller.prepare = lambda key: None
                with mock.patch.object(fanout, 'utcnow', return_value=began), mock.patch.object(fanout, 'execute', return_value=''):
                    controller.initialize({'dagger_version': '0.0.1'})
                    (controller.root / 'operator-key.pub').write_text('ssh-ed25519 FIXTURE')
                    controller.register_keys()
                expected = (began + dt.timedelta(hours=min(4, absolute_hours))).isoformat()
                self.assertEqual(controller.read()['deadline'], expected)
                self.assertEqual(controller.read()['first_creation_at'], began.isoformat())
                with mock.patch.object(fanout, 'utcnow', return_value=began + dt.timedelta(minutes=5)):
                    controller.create('node-001')
                self.assertEqual(controller.read()['deadline'], expected)
                before = list(api.mutations)
                expired = dt.datetime.fromisoformat(expected) + dt.timedelta(seconds=1)
                with mock.patch.object(fanout, 'utcnow', return_value=expired), self.assertRaises(TimeoutError):
                    controller.create('node-002')
                self.assertEqual(api.mutations, before)
                self.assertEqual(controller.read()['deadline'], expected)

    def test_default_cold_initialization_still_starts_budget_at_first_create(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = config(root, 2)
            (root / 'credentials').write_text('fake credentials')
            controller = fanout.Controller(settings, FakeAPI())
            with mock.patch.object(fanout, 'execute', return_value=''):
                controller.initialize({'dagger_version': '0.0.1'})
            self.assertNotIn('deadline', controller.read())
            self.assertNotIn('first_creation_at', controller.read())


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


class SelectedCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.api = FakeAPI()
        settings = dict(config(self.root, 2), check_only='flutter-test')
        settings['accounts'] = [dict(settings['accounts'][0], nodes=3)]
        self.controller = FakeController(settings, self.api)
        # Test the real initialization to retain immutable deadline/scope state;
        # all provider, remote preparation, process and SSH effects remain fake.
        (self.root / 'credentials').write_text('FAKE')
        self.controller.initialize = lambda plan: fanout.Controller.initialize(self.controller, plan)
        self.execution = mock.patch.object(fanout, 'execute', return_value='')
        self.execution.start()
        self.addCleanup(self.execution.stop)
        initialize = self.controller.initialize
        def initialized(plan):
            initialize(plan)
            (self.controller.root / 'operator-key.pub').write_text('ssh-ed25519 FIXTURE')
        self.controller.initialize = initialized

    def run_controller(self):
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            self.controller.run()

    def test_one_worker_only_runs_selected_check_and_retains_exact_scoped_receipt(self):
        self.run_controller()
        state = self.controller.read()
        self.assertEqual(state['status'], 'passed')
        self.assertEqual(state['validation_scope'], 'selected-check')
        self.assertEqual(state['selected_check'], 'flutter-test')
        self.assertEqual([item for item in self.controller.events if isinstance(item, tuple)],
                         [('node-001', 'check-flutter-test')])
        created = [args for _, args in self.api.mutations if args[:3] == ['compute', 'droplet', 'create']]
        self.assertEqual(len(created), 1)
        self.assertEqual(len(state['nodes']), 3)
        self.assertTrue(state['nodes']['node-001']['deletion_verified'])
        self.assertTrue(all(node['status'] == 'planned' and not node.get('creation_attempted')
                            for key, node in state['nodes'].items() if key != 'node-001'))
        self.assertNotIn('bundle', state)
        self.assertNotIn('browser_result_stats', state)
        self.assertIn('validation_completed_at', state)
        receipt = state['selected_check_receipt']
        self.assertEqual({key: receipt[key] for key in ('batch_key', 'source_commit', 'node_id', 'phase', 'check', 'validation_scope')},
                         {'batch_key': 'fixture-ci', 'source_commit': SHA, 'node_id': 'node-001',
                          'phase': 'check-flutter-test', 'check': 'flutter-test', 'validation_scope': 'selected-check'})
        self.assertEqual(receipt['result_sha256'], fanout.file_sha256(self.controller.root / receipt['result_path']))
        self.assertFalse(any(self.api.droplets.values()))
        self.assertFalse(any(self.api.keys.values()))

    def test_failed_selected_check_records_failure_and_removes_resources_without_full_pass(self):
        self.controller.fail_checks = {'check-flutter-test'}
        with self.assertRaises(fanout.PhaseFailure):
            self.run_controller()
        state = self.controller.read()
        self.assertEqual(state['status'], 'stopped')
        self.assertEqual(state['ci_failures'][0]['phase'], 'check-flutter-test')
        self.assertNotIn('selected_check_receipt', state)
        self.assertNotIn('validation_completed_at', state)
        self.assertFalse(any(self.api.droplets.values()))
        self.assertFalse(any(self.api.keys.values()))

    def test_retrieved_result_mismatch_cannot_certify_selected_check(self):
        retrieve = self.controller.retrieve
        def wrong_result(node):
            local = retrieve(node)
            path = local / 'results/check-flutter-test/result.json'
            result = json.loads(path.read_text())
            result['source_commit'] = 'b' * 40
            path.write_text(json.dumps(result))
            return local
        self.controller.retrieve = wrong_result
        with self.assertRaisesRegex(ValueError, 'source-pinned evidence'):
            self.run_controller()
        self.assertNotIn('selected_check_receipt', self.controller.read())
        self.assertFalse(any(self.api.droplets.values()))

    def test_check_start_cannot_extend_absolute_deadline(self):
        deadline = (fanout.utcnow() + dt.timedelta(minutes=10)).isoformat()
        self.controller.config['absolute_deadline'] = deadline
        phase = self.controller.phase
        def expire_after_create(*args, **kwargs):
            self.assertEqual(self.controller.read()['deadline'], deadline)
            with mock.patch.object(fanout, 'utcnow', return_value=dt.datetime.fromisoformat(deadline)):
                phase(*args, **kwargs)
        self.controller.phase = expire_after_create
        with self.assertRaisesRegex(TimeoutError, 'elapsed-time limit'):
            self.run_controller()
        state = self.controller.read()
        self.assertEqual(state['deadline'], deadline)
        self.assertNotIn('selected_check_receipt', state)
        self.assertFalse(any(self.api.droplets.values()))

    def test_cleanup_failure_keeps_watchdog_alive_until_owned_resources_can_be_removed(self):
        remove = self.controller.remove
        self.controller.remove = mock.Mock(side_effect=RuntimeError('temporary provider failure'))
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = None
            process.return_value.pid = 12345
            with self.assertRaisesRegex(RuntimeError, 'cleanup incomplete'):
                self.controller.run()
            process.return_value.terminate.assert_not_called()
        state = self.controller.read()
        self.assertEqual(state['status'], 'cleanup_failed')
        self.assertTrue(state['cleanup_errors'])
        self.assertFalse(state.get('finished_at'))
        self.assertTrue(any(self.api.droplets.values()))
        self.controller.remove = remove
        self.assertTrue(self.controller.watchdog_step())
        self.assertFalse(any(self.api.droplets.values()))
        self.assertFalse(any(self.api.keys.values()))

    def test_unsupported_selected_check_rejected_before_provider_or_state_creation(self):
        for value in ('js-test', 'rust-test', '', None, True, ['flutter-test'], 'flutter-test; touch /tmp/no'):
            with self.subTest(value=value), mock.patch.object(self.api, 'identity') as identity:
                with self.assertRaisesRegex(ValueError, 'standalone flutter-test'):
                    fanout.Controller(dict(self.controller.config, check_only=value), self.api)
                identity.assert_not_called()
                self.assertFalse(self.controller.path.exists())

    def test_real_plan_is_explicitly_one_selected_worker_with_conservative_fleet_price(self):
        api = mock.Mock()
        api.identity.return_value = {'droplet_limit': 10}
        api.call.side_effect = lambda account, args: ([] if args[:2] == ['compute', 'droplet'] else
            [{'slug': self.controller.config['size'], 'available': True,
              'regions': [self.controller.config['region']], 'price_hourly': self.controller.config['expected_hourly_rate']}])
        with mock.patch.object(fanout, 'execute', side_effect=[SHA, '', json.dumps({'engineVersion': 'v0.21.7'})]):
            plan = fanout.Controller(self.controller.config, api).plan()
        self.assertEqual(plan['validation_scope'], 'selected-check')
        self.assertEqual(plan['check_jobs'], ['flutter-test'])
        self.assertEqual(plan['browser_shards'], 0)
        self.assertEqual(plan['initial_nodes'], 1)
        self.assertEqual(plan['nodes'], 3)
        self.assertEqual(plan['hourly_usd'], 3 * self.controller.config['expected_hourly_rate'])
        self.assertFalse(plan['canary_before_remaining_nodes'])


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

    def three_node_controller(self):
        settings = config(self.root, 4)
        settings['accounts'] = [dict(settings['accounts'][0], nodes=3)]
        self.controller = FakeController(settings, self.api)
        return self.controller

    def test_initial_bootstrap_overlaps_builder_api_and_preserves_both_build_gates(self):
        ctl = self.three_node_controller()
        started = {key:threading.Event() for key in ('node-002', 'node-003')}
        api_started, probe_done, source_done = (threading.Event() for _ in range(3))
        prepare, api, probe, preflight, phase = (ctl.prepare, ctl.prepare_dagger_api,
                                               ctl.tiny_probe, ctl.source_preflight, ctl.phase)
        def prepare_node(key):
            if key in started:
                self.assertEqual(ctl.read()['nodes']['node-001']['status'], 'ready')
                started[key].set()
                self.assertTrue(api_started.wait(5), 'builder API preparation did not overlap startup')
            prepare(key)
        def prepare_api(key):
            self.assertTrue(all(event.wait(5) for event in started.values()),
                            'the other initial nodes did not start together')
            api_started.set()
            api(key)
        def portable_probe(builder, canary):
            self.assertEqual(ctl.read()['nodes'][canary]['status'], 'ready')
            probe(builder, canary)
            probe_done.set()
        def source_gate(builder, canary):
            self.assertTrue(probe_done.is_set())
            preflight(builder, canary)
            source_done.set()
        def launch(key, name, kind, args, **kwargs):
            if name == 'build':
                self.assertTrue(probe_done.is_set() and source_done.is_set())
            return phase(key, name, kind, args, **kwargs)
        with mock.patch.object(ctl, 'prepare', side_effect=prepare_node), \
             mock.patch.object(ctl, 'prepare_dagger_api', side_effect=prepare_api), \
             mock.patch.object(ctl, 'tiny_probe', side_effect=portable_probe), \
             mock.patch.object(ctl, 'source_preflight', side_effect=source_gate), \
             mock.patch.object(ctl, 'phase', side_effect=launch), \
             mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            ctl.run()
        self.assertEqual(ctl.events.count(('api-prepared', 'node-001')), 1)
        self.assertEqual(ctl.read()['status'], 'passed')
        self.assertEqual(len([args for _,args in self.api.mutations
                              if args[:3] == ['compute','droplet','create']]), 3)

    def test_completed_startup_failure_prevents_probe_and_real_build(self):
        ctl = self.three_node_controller()
        failed = threading.Event()
        executor = fanout.cf.ThreadPoolExecutor
        class ObservedExecutor(executor):
            def submit(self, function, *args, **kwargs):
                future = super().submit(function, *args, **kwargs)
                if function == ctl.create and args == ('node-003',):
                    future.add_done_callback(lambda _:failed.set())
                return future
        prepare = ctl.prepare
        def prepare_node(key):
            if key == 'node-003':
                raise ValueError('initial worker failed its source/cache proof')
            prepare(key)
        def prepare_api(key):
            self.assertTrue(failed.wait(5), 'failure did not complete during API preparation')
        with mock.patch.object(ctl, 'prepare', side_effect=prepare_node), \
             mock.patch.object(ctl, 'prepare_dagger_api', side_effect=prepare_api), \
             mock.patch.object(fanout.cf, 'ThreadPoolExecutor', ObservedExecutor), \
             mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'source/cache proof'):
                ctl.run()
        self.assertNotIn('tiny-probe', ctl.events)
        self.assertFalse(any(isinstance(item,tuple) and item[1] == 'build' for item in ctl.events))
        self.assertIn('source/cache proof', ctl.read()['startup_errors']['node-003'])
        self.assertEqual(sum(map(len, self.api.droplets.values())), 0)

    def test_probe_failure_joins_late_bootstrap_before_cleanup_and_reconciles_its_error(self):
        ctl = self.three_node_controller()
        started, fail_probe, finished = (threading.Event() for _ in range(3))
        prepare, cleanup = ctl.prepare, ctl.cleanup
        def prepare_node(key):
            if key == 'node-003':
                started.set()
                self.assertTrue(fail_probe.wait(5))
                # The controller must signal stop before waiting for startup.
                for _ in range(500):
                    if ctl.read()['stop_requested']:
                        break
                    threading.Event().wait(.01)
                self.assertTrue(ctl.read()['stop_requested'])
                finished.set()
                raise RuntimeError('late bootstrap stopped')
            prepare(key)
        def probe(builder, canary):
            self.assertTrue(started.wait(5))
            fail_probe.set()
            raise ValueError('portable OCI probe failed')
        def joined_cleanup(*args, **kwargs):
            self.assertTrue(finished.is_set(), 'cleanup raced an outstanding startup attempt')
            return cleanup(*args, **kwargs)
        with mock.patch.object(ctl, 'prepare', side_effect=prepare_node), \
             mock.patch.object(ctl, 'tiny_probe', side_effect=probe), \
             mock.patch.object(ctl, 'cleanup', side_effect=joined_cleanup), \
             mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'portable OCI probe failed'):
                ctl.run()
        self.assertEqual(ctl.read()['startup_errors']['node-003'], 'late bootstrap stopped')
        self.assertEqual(sum(map(len, self.api.droplets.values())), 0)
        self.assertTrue(all(node.get('deletion_verified') for node in ctl.read()['nodes'].values()))

    def test_portable_fixture_api_preparation_is_once_per_pinned_node_and_source(self):
        self.initialize()
        for key in ('node-001','node-002'):
            self.controller.create(key)
            self.controller.node_update(key, ip='192.0.2.1')
            (self.controller.root / key).mkdir()
        ctl = self.controller
        def prepare(key):
            fanout.Controller.prepare_dagger_api(ctl, key)
        def ssh(key, command, **kwargs):
            return 'API functions' if command.endswith('dagger functions') else 'b'*64 + ' client.oci.tar'
        with mock.patch.object(ctl, 'prepare_dagger_api', side_effect=prepare), \
             mock.patch.object(ctl, 'ssh', side_effect=ssh) as remote, \
             mock.patch.object(fanout, 'execute') as upload:
            prepare('node-001')
            fanout.Controller.tiny_probe(ctl, 'node-001','node-002')
        api_calls = [call.args[0] for call in remote.call_args_list if call.args[1].endswith('dagger functions')]
        self.assertEqual(api_calls, ['node-001','node-002'])
        self.assertEqual(upload.call_count, 2)
        self.assertTrue(ctl.read()['oci_probe_passed_at'])
        ctl.node_update('node-001', dagger_api_prepared={'node_id':'node-002','source_commit':SHA})
        with mock.patch.object(fanout, 'execute') as upload, self.assertRaisesRegex(ValueError,'different node or source'):
            prepare('node-001')
        upload.assert_not_called()

    def test_plan_separates_initial_allocation_from_preflight_and_later_browser_canary(self):
        ctl = self.three_node_controller()
        call = self.api.call
        def provider(account, args):
            if args == ['compute','size','list']:
                return [{'slug':ctl.config['size'], 'available':True, 'regions':[ctl.config['region']],
                         'price_hourly':ctl.config['expected_hourly_rate']}]
            return call(account, args)
        with mock.patch.object(self.api, 'call', side_effect=provider), \
             mock.patch.object(fanout, 'execute', side_effect=[SHA,'',json.dumps({'engineVersion':'0.21.7'})]):
            plan = fanout.Controller.plan(ctl)
        self.assertEqual(plan['nodes'], 3)
        self.assertEqual(plan['initial_nodes'], 3)
        self.assertFalse(plan['canary_before_remaining_nodes'])
        self.assertTrue(plan['builder_ready_before_parallel_initial_nodes'])
        self.assertTrue(plan['two_machine_preflight_before_real_build'])
        self.assertTrue(plan['browser_canary_before_additional_shards'])

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

    def test_setup_byte_change_fails_real_before_after_gate_without_building_or_growing_past_initial_hosts(self):
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
        created = len([args for _,args in self.api.mutations if args[:3] == ['compute','droplet','create']])
        self.assertGreaterEqual(created, 2)
        self.assertLessEqual(created, len(fanout.CHECKS) + 1)
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

    def test_input_mismatch_stops_before_expensive_build_and_removes_initial_hosts(self):
        self.controller.fail_inputs = True
        with mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            with self.assertRaisesRegex(ValueError, 'Source inputs differ'):
                self.controller.run()
        created = [args for _, args in self.api.mutations if args[:3] == ['compute', 'droplet', 'create']]
        self.assertGreaterEqual(len(created), 2)
        self.assertLessEqual(len(created), len(fanout.CHECKS) + 1)
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
        shared = next(index for index, event in enumerate(self.controller.events)
                      if isinstance(event, tuple) and event[0] == 'share')
        browser = self.controller.events.index(('node-002', 'browser'))
        self.assertLess(shared, browser)
        self.assertEqual(sum(len(value) for value in self.api.droplets.values()), 0)
        self.assertEqual(self.controller.read()['status'], 'stopped')

    def test_archive_preserves_real_payload_and_original_build_evidence_then_restores(self):
        self.controller.config['artifact_archive_dir'] = str(self.root / 'archives')
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
        def download(node, sources, destination, download=False, timeout=180, cancel=None):
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
            with self.assertRaises(TimeoutError):
                fanout.Controller.archive_bundle(self.controller,'node-001')
            self.assertTrue(archived.is_dir())
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

    def test_default_ci_completes_without_host_backup_but_still_shares_bundle(self):
        self.controller = FakeController(config(self.root, 4), self.api)
        with mock.patch.object(self.controller, 'archive_bundle') as archive, mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            self.controller.run()
        archive.assert_not_called()
        state = self.controller.read()
        self.assertEqual(state['status'], 'passed')
        self.assertTrue(state['validation_passed_at'])
        self.assertEqual(state['full_browser_test_count'], 4)
        self.assertEqual(state['nodes']['node-001']['bundle_backup_status'], 'disabled')
        self.assertNotIn('bundle_backup_started_at', state['nodes']['node-001'])
        self.assertIsNone(self.controller.backup_thread)
        self.assertIn(('restore', 'node-001'), self.controller.events)
        self.assertTrue(any(isinstance(event, tuple) and event[0] == 'share' for event in self.controller.events))
        checks = [event[1] for event in self.controller.events if isinstance(event, tuple)
                  and isinstance(event[1], str) and event[1].startswith('check-')]
        self.assertCountEqual(checks, ['check-' + name for name, _ in fanout.CHECKS])
        self.assertEqual(sum(map(len, self.api.droplets.values())), 0)

    def test_slow_optional_backup_does_not_block_share_prepared_checks_or_browsers(self):
        self.controller = FakeController(dict(config(self.root, 4), host_bundle_backup=True), self.api)
        started = threading.Event()
        browser_during_backup = threading.Event()
        def slow_backup(builder):
            self.assertTrue(any(isinstance(event, tuple) and event[0] == 'share' for event in self.controller.events))
            started.set()
            if not self.controller.backup_cancel.wait(5):
                raise AssertionError('CI waited for the optional backup')
            raise fanout.cf.CancelledError('optional backup cancelled')
        original = self.controller.run_browser_shard
        def browser(key, builder):
            self.assertTrue(started.wait(1))
            self.assertTrue(self.controller.backup_thread.is_alive())
            browser_during_backup.set()
            return original(key, builder)
        with mock.patch.object(self.controller, 'archive_bundle', side_effect=slow_backup), mock.patch.object(self.controller, 'run_browser_shard', side_effect=browser), mock.patch.object(fanout.subprocess, 'Popen') as process:
            process.return_value.poll.return_value = 0
            process.return_value.pid = 12345
            self.controller.run()
        state = self.controller.read()
        self.assertTrue(browser_during_backup.is_set())
        self.assertEqual(state['status'], 'passed')
        self.assertEqual(state['full_browser_test_count'], 4)
        self.assertTrue(state['validation_passed_at'])
        self.assertEqual(state['nodes']['node-001']['bundle_backup_status'], 'failed')
        self.assertFalse(self.controller.backup_thread.is_alive())
        checks = [event[1] for event in self.controller.events if isinstance(event, tuple)
                  and isinstance(event[1], str) and event[1].startswith('check-')]
        self.assertCountEqual(checks, ['check-' + name for name, _ in fanout.CHECKS])
        self.assertEqual(sum(map(len, self.api.droplets.values())), 0)

    def test_backup_io_failure_is_nonfatal_but_provenance_failure_remains_fatal(self):
        for failure, check_failed in ((OSError('laptop disk unavailable'), False),
                                      (OSError('laptop disk unavailable'), True),
                                      (ValueError('archive manifest provenance mismatch'), False)):
            with self.subTest(failure=failure, check_failed=check_failed), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root / 'probe').mkdir()
                (root / 'probe/dagger.json').write_text('{}')
                controller = FakeController(dict(config(root, 4), host_bundle_backup=True), FakeAPI())
                if check_failed:
                    controller.fail_checks = {'check-rust-fmt'}
                with mock.patch.object(controller, 'archive_bundle', side_effect=failure), mock.patch.object(fanout.subprocess, 'Popen') as process:
                    process.return_value.poll.return_value = 0
                    process.return_value.pid = 12345
                    if isinstance(failure, ValueError):
                        with self.assertRaisesRegex(ValueError, 'provenance'):
                            controller.run()
                    elif check_failed:
                        with self.assertRaises(fanout.CIValidationFailure):
                            controller.run()
                    else:
                        controller.run()
                state = controller.read()
                self.assertEqual(state['nodes']['node-001']['bundle_backup_status'], 'failed')
                self.assertIn(str(failure), state['nodes']['node-001']['bundle_backup_error'])
                self.assertNotIn('bundle_archived_at', state['nodes']['node-001'])
                self.assertEqual('validation_passed_at' in state, not isinstance(failure, ValueError) and not check_failed)
                self.assertFalse(controller.backup_thread.is_alive())
                self.assertEqual(sum(map(len, controller.api.droplets.values())), 0)

    def test_backup_programming_error_or_missing_archive_cannot_be_ignored(self):
        for outcome in (RuntimeError('unexpected controller defect'), None):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as temp:
                controller = FakeController(config(Path(temp), 4), FakeAPI())
                controller.initialize(controller.plan())
                patch = {'side_effect': outcome} if isinstance(outcome, Exception) else {'return_value': outcome}
                with mock.patch.object(controller, 'archive_bundle', **patch):
                    controller.start_bundle_backup('node-001')
                    controller.backup_thread.join(2)
                    with self.assertRaisesRegex(ValueError, 'unexpected controller defect|no successful build archive'):
                        controller.stop_bundle_backup(raise_fatal=True)
                node = controller.read()['nodes']['node-001']
                self.assertEqual(node['bundle_backup_status'], 'failed')
                self.assertTrue(node['bundle_backup_fatal'])
                self.assertNotIn('bundle_archived_at', node)
                self.assertFalse(controller.backup_thread.is_alive())

    def test_actual_failed_backup_command_is_optional_io_with_no_published_archive(self):
        self.controller.config['artifact_archive_dir'] = str(self.root / 'archives')
        self.initialize()
        self.controller.node_update('node-001', ip='127.0.0.1')
        result = {'status': 'passed', 'source_commit': SHA, 'node_id': 'node-001', 'phase': 'build',
                  'batch_key': self.controller.config['batch_key'], 'commands': [{'exit_code': 0}]}
        self.controller.update(lambda state: state['nodes']['node-001']['phase_results'].update(build=result))
        self.controller.update(lambda state: state.update(bundle={'manifest_sha256': 'b' * 64}))
        with mock.patch.object(self.controller, 'archive_bundle', side_effect=lambda builder: fanout.Controller.archive_bundle(self.controller, builder)), mock.patch.object(fanout, 'execute', side_effect=fanout.CommandExecutionError('Command failed: scp (exit 1): permission denied')) as command:
            self.controller.start_bundle_backup('node-001')
            self.controller.backup_thread.join(2)
            self.controller.stop_bundle_backup(raise_fatal=True)
        self.assertEqual(command.call_args.args[0][0], 'scp')
        node = self.controller.read()['nodes']['node-001']
        self.assertEqual(node['bundle_backup_status'], 'failed')
        self.assertFalse(node['bundle_backup_fatal'])
        self.assertIn('permission denied', node['bundle_backup_error'])
        self.assertNotIn('bundle_archived_at', node)
        self.assertEqual(list(Path(self.controller.config['artifact_archive_dir']).iterdir()), [])

    def test_cleanup_cancels_backup_waiting_on_an_existing_archive_lock(self):
        self.initialize()
        attempted = threading.Event()
        def archive(builder):
            attempted.set()
            return fanout.Controller.archive_bundle(self.controller, builder)
        with self.controller.lock('bundle-archive'), mock.patch.object(self.controller, 'archive_bundle', side_effect=archive):
            self.controller.start_bundle_backup('node-001')
            self.assertTrue(attempted.wait(1))
            self.controller.stop_bundle_backup()
            self.assertFalse(self.controller.backup_thread.is_alive())
        self.assertEqual(self.controller.read()['nodes']['node-001']['bundle_backup_status'], 'failed')

    def test_timed_out_backup_removes_partial_and_never_claims_completed_archive(self):
        self.controller.config['artifact_archive_dir'] = str(self.root / 'archives')
        self.initialize()
        result = {'status': 'passed', 'source_commit': SHA, 'node_id': 'node-001', 'phase': 'build',
                  'batch_key': self.controller.config['batch_key'], 'commands': [{'exit_code': 0}]}
        self.controller.update(lambda state: state['nodes']['node-001']['phase_results'].update(build=result))
        self.controller.update(lambda state: state.update(bundle={'manifest_sha256': 'b' * 64},
            deadline=(fanout.utcnow() + dt.timedelta(hours=1)).isoformat()))
        def interrupted_copy(node, sources, destination, download=False, timeout=180, cancel=None):
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 120)
            self.assertTrue(callable(cancel))
            (destination / 'client.oci.tar').write_text('incomplete transfer')
            raise subprocess.TimeoutExpired(['scp'], timeout)
        with mock.patch.object(self.controller, 'archive_bundle', side_effect=lambda builder: fanout.Controller.archive_bundle(self.controller, builder)), mock.patch.object(self.controller, 'scp', side_effect=interrupted_copy):
            self.controller.start_bundle_backup('node-001')
            self.controller.backup_thread.join(2)
            self.controller.stop_bundle_backup()
        node = self.controller.read()['nodes']['node-001']
        self.assertEqual(node['bundle_backup_status'], 'failed')
        self.assertFalse(self.controller.backup_thread.is_alive())
        self.assertNotIn('bundle_archived_at', node)
        self.assertEqual(list(Path(self.controller.config['artifact_archive_dir']).iterdir()), [])
        with self.controller.lock('bundle-archive'):
            pass

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
