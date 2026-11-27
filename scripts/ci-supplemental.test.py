#!/usr/bin/env python3
"""No Docker/provider calls: fixed recipe, privacy, result and lifecycle gates."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

supp=load('ci-supplemental')
native=load('ci-fanout-native')
base=load('ci-fanout')
SHA='a'*40
PRIVATE='b'*40
HASH='c'*64


def phase(group='native'):
    return {'supplemental_profile':supp.PROFILE,'group':group,'source_commit':SHA,
        'batch_key':'fixture','node_id':'node-002','jobs':16,
        'private_root':'/mnt/atomic-ci/private/fixture/node-002/'+group,
        'deadline':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=10)).isoformat(),
        'private_input':{'source_commit':PRIVATE,'archive_sha256':HASH,'manifest_sha256':HASH}}


class FakeDriver(supp.Driver):
    def __init__(self, settings, failed=None, prepared=True):
        super().__init__(settings)
        self.ran=[]; self.failed=failed; self.prepared=prepared; self.cleaned=False
    def prepare(self):
        self.image_id='sha256:'+HASH if self.prepared else None
        return self.prepared
    def start(self): pass
    def run_case(self,name):
        self.ran.append(name)
        ok=name!=self.failed
        return {'id':name,'status':'passed' if ok else 'failed','exit_code':0 if ok else 1,
                'browser_passed':(2 if name=='vault-workspace' else 1) if ok and name in ('vault-workspace','iroh-renderer','webrtc-renderer') else None,
                'finished_at':supp.stamp()}
    def cleanup(self): self.cleaned=True
    def verify_sources(self): pass


class RecipeTests(unittest.TestCase):
    def test_actual_cases_are_named_and_independent_after_an_ordinary_failure(self):
        for failed in ('native-clippy','native-peer','native-vault','iroh-reopen','iroh-renderer'):
            with self.subTest(failed=failed):
                driver=FakeDriver(phase(),failed)
                receipt=driver.run()
                self.assertEqual(driver.ran,list(supp.GROUPS['native']))
                self.assertTrue(driver.cleaned)
                self.assertEqual(receipt['status'],'failed')
                self.assertEqual(native.verify_receipt(receipt,phase()),receipt)
                self.assertEqual(receipt['cases'][-1]['status'],'passed')

    def test_build_failure_records_every_dependent_as_blocked_without_claiming_pass(self):
        for group in supp.GROUPS:
            driver=FakeDriver(phase(group),supp.GROUPS[group][0])
            receipt=driver.run()
            self.assertEqual(driver.ran,[supp.GROUPS[group][0]])
            self.assertTrue(all(case['status']=='blocked' for case in receipt['cases'][1:]))
            self.assertEqual(receipt['status'],'failed')
            native.verify_receipt(receipt,phase(group))

    def test_preparation_failure_cannot_become_a_zero_case_pass(self):
        driver=FakeDriver(phase(),prepared=False)
        receipt=driver.run()
        self.assertFalse(driver.ran)
        self.assertTrue(receipt['cases'])
        self.assertEqual(receipt['status'],'failed')
        native.verify_receipt(receipt,phase())

    def test_invalid_profile_identity_and_private_paths_fail_before_any_execution(self):
        for patch in ({'supplemental_profile':'arbitrary'},{'group':'bash -c no'},
                      {'private_root':'/opt/atomic-ci/results/private'}, {'private_root':'/root/private'},
                      {'source_commit':'bad'},{'jobs':True},{'jobs':33}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                FakeDriver(dict(phase(),**patch))

    def test_sanitized_receipt_rejects_private_fields_broadened_scope_and_wrong_sources(self):
        receipt=FakeDriver(phase()).run()
        mutations=[lambda r:r.update(private_source_commit='d'*40),lambda r:r.update(raw_stderr='SIGNED_URL_SECRET'),
                   lambda r:r.update(cases=r['cases'][:-1]),lambda r:r['cases'][0].update(stdout='PRIVATE_SOURCE'),
                   lambda r:r['cases'][-1].update(browser_passed=0),lambda r:r.update(completed=False),
                   lambda r:r.update(image_id=None),lambda r:r['cases'][0].update(exit_code=True)]
        for mutate in mutations:
            bad=copy.deepcopy(receipt);mutate(bad)
            with self.subTest(mutate=mutate),self.assertRaises(ValueError): native.verify_receipt(bad,phase())

    def test_browser_zero_tests_skips_retries_and_global_errors_fail(self):
        passed={'status':'expected','expectedStatus':'passed','results':[{'status':'passed','retry':0}]}
        report={'errors':[],'suites':[{'specs':[{'tests':[passed]}]}]}
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'private-report.json';path.write_text(json.dumps(report))
            self.assertEqual(supp.report_count(path,1),1)
            for variant in ('skip','retry','global','zero','failed'):
                value=copy.deepcopy(report)
                case=value['suites'][0]['specs'][0]['tests'][0]
                if variant=='skip':case.update(status='skipped')
                if variant=='retry':case['results'].append({'status':'passed','retry':1})
                if variant=='global':value['errors']=[{'message':'SECRET'}]
                if variant=='zero':value['suites']=[]
                if variant=='failed':case['results'][0]['status']='failed'
                path.write_text(json.dumps(value))
                with self.subTest(variant=variant),self.assertRaises(ValueError):supp.report_count(path,1)

    def test_main_never_publishes_raw_exception_details(self):
        with tempfile.TemporaryDirectory() as temp:
            config=Path(temp)/'phase.json';config.write_text(json.dumps(phase()))
            receipt=Path(temp)/'result.json'
            with mock.patch.object(supp.sys,'argv',['driver','--config',str(config),'--receipt',str(receipt)]), \
                 mock.patch.object(supp.Driver,'run',side_effect=ValueError('SIGNED_URL_SECRET')), \
                 mock.patch('builtins.print') as output:
                self.assertEqual(supp.main(),2)
            self.assertNotIn('SIGNED_URL_SECRET',repr(output.call_args_list))
            self.assertFalse(receipt.exists())

    def test_cleanup_requires_label_ownership_and_positive_absence_proof(self):
        owned=json.dumps({'atomic-ci-batch':'fixture','atomic-ci-source':SHA})
        scenarios=[([(0,owned),(0,''),(0,'')],True),
                   ([(1,'transport error'),(0,'')],True),
                   ([(1,'transport error'),(1,'error')],False),
                   ([(1,'error'),(0,'still-present')],False),
                   ([(0,owned),(0,''),(0,'still-present')],False),
                   ([(0,json.dumps({'atomic-ci-batch':'foreign'}))],False)]
        for values,passed in scenarios:
            calls=[]
            def execute(args,log,capture):
                calls.append(args);return values[len(calls)-1]
            driver=supp.Driver(phase(),execute=execute)
            if passed:driver.cleanup()
            else:
                with self.assertRaises(ValueError):driver.cleanup()
            if values[0][0]==1 or 'foreign' in values[0][1]:
                self.assertFalse(any(args[:2]==['docker','rm'] for args in calls))

    def test_recipes_keep_real_native_cases_and_private_commands(self):
        self.assertIn('NATIVE_RECOVERY_BUILD_ONLY=true',supp.RECIPES['native-build'])
        self.assertIn('NATIVE_RECOVERY_CASE=peer',supp.RECIPES['native-peer'])
        self.assertIn('NATIVE_RECOVERY_CASE=vault',supp.RECIPES['native-vault'])
        for name in ('private-check','private-clippy','private-test'):
            self.assertIn('--locked',supp.RECIPES[name]);self.assertNotIn('--workspace',supp.RECIPES[name])
        for name in ('managed-check','managed-clippy','managed-test'):
            self.assertIn('-p atomic-managed-node',supp.RECIPES[name])
        self.assertNotIn('/var/run/docker.sock',repr(supp.RECIPES))


class HookTests(unittest.TestCase):
    def test_watchdog_persists_normalized_defaults_without_overwriting_an_old_runtime(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temp:
            raw={'source_commit':SHA}
            normalized=dict(raw,supplemental_jobs=16)
            controller=SimpleNamespace(root=Path(temp)/'runtime',config=normalized)
            native.initialize_runtime_config(controller)
            path=controller.root/'config.json'
            self.assertEqual(json.loads(path.read_text()),normalized)
            self.assertNotEqual(json.loads(path.read_text()),raw)
            self.assertEqual(path.stat().st_mode & 0o077,0)
            with self.assertRaises(FileExistsError):native.initialize_runtime_config(controller)

    def test_public_default_extra_gate_is_noop_and_core_identity_cannot_be_replaced(self):
        self.assertIsNone(base.Controller.validate_additional_results(None,[]))
        self.assertEqual(base.Controller.phase_config_fields(None,'node','name','check'),{})
        self.assertEqual(len(base.CHECKS),10)

    def test_opt_in_resource_sampler_uses_only_pinned_fixed_command_and_original_deadline(self):
        ctl=object.__new__(base.Controller)
        ctl.config={'sample_resources':False}
        ctl.ssh=mock.Mock();ctl.check_deadline=mock.Mock();ctl.node_update=mock.Mock()
        ctl.start_resource_sampler('node-002')
        ctl.ssh.assert_not_called()
        deadline=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=10)).isoformat()
        ctl.config['sample_resources']=True;ctl.read=lambda:{'deadline':deadline}
        ctl.start_resource_sampler('node-002')
        command=ctl.ssh.call_args_list[-1].args[1]
        self.assertIn('/opt/atomic-ci/repo/scripts/ci-resource-sampler.py',command)
        self.assertIn('--interval 20',command);self.assertIn(deadline,command)
        self.assertIn('RuntimeMaxSec=',command);self.assertIn('KillMode=control-group',command)
        self.assertIn('/opt/atomic-ci/results/telemetry/resources.jsonl',command)

    def test_missing_feature_interfaces_fail_before_provider_plan(self):
        from types import SimpleNamespace
        calls=[]
        def source(args,**kwargs):
            calls.append(args)
            return b'ordinary source without native case interfaces'
        with self.assertRaisesRegex(ValueError,'harness interfaces'):
            native.source_capabilities({'source_commit':SHA,'worktree':'/owned'},SimpleNamespace(execute=source))
        self.assertEqual(len(calls),len(native.REQUIRED_SOURCE))
        cls=native.controller_class(base)
        ctl=object.__new__(cls);ctl.config={}
        with mock.patch.object(native,'source_capabilities',side_effect=ValueError('missing harness')), \
             mock.patch.object(base.Controller,'plan') as provider:
            with self.assertRaisesRegex(ValueError,'missing harness'):ctl.plan()
        provider.assert_not_called()

    def test_early_removal_requires_supplemental_terminal_receipt(self):
        cls=native.controller_class(base)
        ctl=object.__new__(cls)
        node={'shard_index':2}
        ctl.read=lambda:{'nodes':{'node-002':node},'stop_requested':False}
        with self.assertRaisesRegex(ValueError,'before early'):ctl.remove('node-002')
        with mock.patch.object(base.Controller,'remove',return_value='removed'):
            node['supplemental_verified_at']=supp.stamp()
            self.assertEqual(ctl.remove('node-002'),'removed')
            node.pop('supplemental_verified_at')
            ctl.read=lambda:{'nodes':{'node-002':node},'stop_requested':True}
            self.assertEqual(ctl.remove('node-002'),'removed')

    def test_missing_failed_or_blocked_supplemental_cannot_set_overall_pass(self):
        cls=native.controller_class(base)
        ctl=object.__new__(cls)
        ctl.update=lambda callback: callback(state)
        settings=[phase('native'),phase('private-vault')]
        nodes={f'node-00{i+2}':{'shard_index':i+2,'phase_kind':'browser','supplemental_phase_config':cfg,
                    'supplemental_verified_at':supp.stamp(),'supplemental_receipt':FakeDriver(cfg).run()}
                    for i,cfg in enumerate(settings)}
        state={'nodes':nodes};ctl.read=lambda:state
        ctl.validate_additional_results(list(nodes))
        self.assertEqual(state['supplemental_results'],{'native':'passed','private-vault':'passed'})
        nodes['node-002'].pop('supplemental_verified_at')
        with self.assertRaises(base.CIValidationFailure):ctl.validate_additional_results(list(nodes))
        nodes['node-002']['supplemental_verified_at']=supp.stamp()
        nodes['node-002']['supplemental_receipt']=FakeDriver(settings[0],failed='native-peer').run()
        with self.assertRaises(base.CIValidationFailure):ctl.validate_additional_results(list(nodes))
        self.assertNotIn('validation_passed_at',state)


class TransportTests(unittest.TestCase):
    def test_fixed_driver_runner_distinguishes_completed_failures_from_integrity_failure(self):
        runner=load('ci-fanout-runner')
        for exit_code in (0,1,2):
            with self.subTest(exit_code=exit_code),tempfile.TemporaryDirectory() as temp:
                root=Path(temp)
                repo=root/'repo';(repo/'scripts').mkdir(parents=True)
                (repo/'scripts/ci-supplemental.py').write_text('def validate_phase(config): pass\n')
                settings=phase();settings['private_root']=str(root/'private/native')
                config={'batch_key':'fixture','node_id':'node-002','source_commit':SHA,
                        'kind':'supplemental','phase':'supplemental-native','args':[], 'supplemental':settings}
                path=root/'phase.json';path.write_text(json.dumps(config))
                calls=[]
                def run(command,cwd,log):
                    calls.append(command)
                    if exit_code in (0,1):
                        receipt=FakeDriver(phase(),failed='native-peer' if exit_code else None).run()
                        (root/'results/supplemental-native/supplemental-receipt.json').write_text(json.dumps(receipt))
                    return exit_code
                with mock.patch.object(runner,'ROOT',root),mock.patch.object(runner,'check_identity'), \
                     mock.patch.object(runner,'check_prepared_bundle'),mock.patch.object(runner,'run',side_effect=run):
                    self.assertEqual(runner.main(path),0 if exit_code==0 else 1)
                self.assertEqual(len(calls),1)
                self.assertIn('ci-supplemental.py',calls[0][1])
                self.assertNotIn('dagger',calls[0])
                result=json.loads((root/'results/supplemental-native/result.json').read_text())
                if exit_code==1:
                    self.assertEqual(result['failure_scope'],'completed-supplemental')
                    self.assertEqual(result['error'],'RuntimeError: phase command exited 1')
                elif exit_code==2:
                    self.assertNotIn('failure_scope',result)
                else:self.assertEqual(result['status'],'passed')

    def test_observed_and_retrieved_receipts_must_agree_in_hash_source_and_exit(self):
        cls=native.controller_class(base)
        for variant in ('valid','hash','source','exit','status','raw-field'):
            with self.subTest(variant=variant),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);folder=root/'results/supplemental-native';folder.mkdir(parents=True)
                settings=phase();receipt=FakeDriver(settings,failed='native-peer').run()
                if variant=='source':receipt['private_source_commit']='d'*40
                if variant=='raw-field':receipt['raw']='PRIVATE_CODE'
                path=folder/'supplemental-receipt.json';path.write_text(json.dumps(receipt))
                result={'status':'failed','commands':[{'exit_code':1}], 'supplemental_receipt_sha256':base.file_sha256(path)}
                if variant=='hash':result['supplemental_receipt_sha256']='d'*64
                if variant=='exit':result['commands'][0]['exit_code']=0
                if variant=='status':result['status']='passed'
                (folder/'result.json').write_text(json.dumps(result))
                node={'phase':'supplemental-native','phase_results':{'supplemental-native':result},
                      'phase_config':{'supplemental':settings}}
                ctl=object.__new__(cls);ctl.read=lambda:{'nodes':{'node-002':node}}
                ctl.retrieve=lambda key:root
                ctl.node_update=lambda key,**kwargs:node.update(kwargs)
                if variant=='valid':
                    self.assertEqual(ctl.verify_supplemental('node-002')['status'],'failed')
                    self.assertTrue(node['supplemental_verified_at'])
                else:
                    with self.assertRaises(ValueError):ctl.verify_supplemental('node-002')
                    self.assertNotIn('supplemental_verified_at',node)


if __name__=='__main__':unittest.main()
