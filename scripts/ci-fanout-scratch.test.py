#!/usr/bin/env python3
"""Cold scratch regressions; all provider, device and process effects are fakes."""
import ast
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest import mock


def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

scratch=load('ci-fanout-scratch'); base=load('ci-fanout'); fixtures=load('ci-fanout.test'); cloud=load('ci-fanout-cloud')


class API(fixtures.FakeAPI):
    def __init__(self):
        super().__init__(); self.volumes=[]; self.volume_creates=0; self.lose_volume=False; self.deleted_volumes=[]
    def raw(self,account,args):
        if args[:2]==['compute','volume']:
            if args[2]=='list': return copy.deepcopy(self.volumes)
            if args[2]=='create':
                self.volume_creates+=1
                value={'id':'33333333-3333-3333-3333-'+str(self.volume_creates).zfill(12),'name':args[3],
                       'region':{'slug':'ams3'},'size_gigabytes':200,'description':args[args.index('--desc')+1],
                       'created_at':base.stamp(),'droplet_ids':[]}
                self.volumes.append(value)
                if self.lose_volume: raise TimeoutError('lost volume create response')
                return [copy.deepcopy(value)]
            if args[2]=='delete':
                self.deleted_volumes.append(args[3]); self.volumes[:]=[v for v in self.volumes if v['id']!=args[3]]; return
        result=super().raw(account,args)
        if args[:3]==['compute','droplet','create']:
            ident=result[0]['id']
            for volume in self.volumes:
                if volume['id']==args[args.index('--volumes')+1]: volume['droplet_ids']=[ident]
        elif args[:3]==['compute','droplet','delete']:
            for volume in self.volumes: volume['droplet_ids']=[i for i in volume['droplet_ids'] if i!=int(args[3])]
        return result


class ScratchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup); self.root=Path(self.temp.name).resolve()
        self.config=fixtures.config(self.root,2)
        self.config['accounts']=[dict(self.config['accounts'][0],nodes=3)]
        self.config.update(cold_scratch_gib=200,expected_scratch_volume_hourly_rate=.03,max_hours=.5,max_total_usd=7.5,authorization='bounded test')
        self.api=API(); self.ctl=scratch.controller_class(base,api_factory=lambda _:self.api)(self.config)
        (self.root/'credentials').write_text('fake')
        with mock.patch.object(base,'execute',return_value=''):
            self.ctl.initialize({'dagger_version':'0.21.7','nodes':3})
        self.ctl.prepare=lambda node:self.ctl.node_update(node,status='ready')
        (self.ctl.root/'operator-key.pub').write_text('ssh-ed25519 FIXTURE')
        self.ctl.register_keys()
    def test_invalid_storage_never_calls_provider(self):
        for changed in ({'cold_scratch_gib':True},{'cold_scratch_gib':201},{'cloud_worker_mode':'warm'},
                        {'source_snapshots':{}},{'expected_scratch_volume_hourly_rate':0},{'authorization':''}):
            with self.subTest(changed=changed),mock.patch.object(self.api,'identity') as identity:
                with self.assertRaises(ValueError): scratch.controller_class(base,api_factory=lambda _:self.api)(dict(self.config,**changed))
                identity.assert_not_called()
    def test_volume_is_attached_at_creation_and_both_resources_are_verified_deleted(self):
        before=self.ctl.read()['deadline']; self.ctl.create('node-001')
        state=self.ctl.read(); ledger=json.loads((self.ctl.root/'scratch-volumes.json').read_text())
        entry=next(iter(ledger.values())); node=state['nodes']['node-001']
        self.assertTrue(scratch.owned_volume(self.api.volumes[0],entry,node,self.config))
        self.assertEqual(self.api.volumes[0]['droplet_ids'],[node['droplet_id']])
        self.assertEqual(self.api.volume_creates,1); self.assertEqual(state['deadline'],before)
        self.ctl.cleanup()
        self.assertFalse(self.api.volumes); self.assertFalse(any(self.api.droplets.values()))
        proof=json.loads((self.ctl.root/'scratch-cleanup.json').read_text())
        self.assertTrue(proof['all_deleted']); self.assertGreater(proof['estimated_storage_usd'],0)
        self.assertTrue(next(iter(json.loads((self.ctl.root/'scratch-volumes.json').read_text()).values()))['deletion_verified'])
    def test_lost_volume_response_is_reconciled_without_second_creation(self):
        self.api.lose_volume=True
        with self.assertRaises(TimeoutError): self.ctl.create('node-001')
        self.assertEqual(self.api.volume_creates,1)
        with mock.patch.object(base,'utcnow',return_value=base.utcnow()+dt.timedelta(seconds=121)):
            self.ctl.cleanup()
        self.assertFalse(self.api.volumes); self.assertEqual(len(self.api.deleted_volumes),1)
    def test_stop_after_identity_prevents_paid_volume(self):
        identity=self.api.identity
        count=0
        def stop(account):
            nonlocal count
            result=identity(account); count+=1
            if count==3: self.ctl.update(lambda state:state.update(stop_requested=True))
            return result
        with mock.patch.object(self.api,'identity',side_effect=stop),self.assertRaises((TimeoutError,RuntimeError)):
            self.ctl.create('node-001')
        self.assertEqual(self.api.volume_creates,0)
    def test_preexisting_or_wrong_snapshot_volume_cannot_be_owned(self):
        self.ctl.create('node-001'); entry=next(iter(json.loads((self.ctl.root/'scratch-volumes.json').read_text()).values()))
        node=self.ctl.read()['nodes']['node-001']
        for key,value in [('snapshot_id','old-snapshot'),('description','foreign'),('size_gigabytes',10),('id','retained')]:
            volume=dict(self.api.volumes[0],**{key:value}); config=dict(self.config,cloud_volume_id='retained')
            self.assertFalse(scratch.owned_volume(volume,entry,node,config))
    def test_cloud_init_blocks_services_before_install_and_defers_docker_readiness(self):
        text=self.ctl.cloud_init('0.21.7')
        self.assertLess(text.index('systemctl, mask'),text.index('packages:'))
        self.assertIn('containerd.service',text); self.assertIn('storage-pending',text)
        self.assertNotIn('touch /var/lib/atomic-ci-ready',text)
        self.assertNotIn('mkfs',text); self.assertNotIn('enable, --now, docker',text)
    def test_startup_proof_requires_both_owned_roots_and_real_free_space(self):
        self.ctl.create('node-001'); entry=next(iter(json.loads((self.ctl.root/'scratch-volumes.json').read_text()).values()))
        proof={k:entry[k] for k in ('batch_key','node_id','id','nonce','filesystem_uuid')}
        proof.update(mount_target='/mnt/atomic-ci',device_realpath='/dev/sdb',docker_root_dir='/mnt/atomic-ci/docker',
                     containerd_root='/mnt/atomic-ci/containerd',containerd_roots=['/mnt/atomic-ci/containerd'],free_bytes=100*1024**3)
        node=self.ctl.read()['nodes']['node-001']; scratch.validate_startup(entry,node,proof)
        for key,value in [('containerd_roots',['/var/lib/containerd']),('free_bytes',0),('nonce','foreign'),('mount_target','/')]:
            with self.subTest(key=key),self.assertRaises(ValueError): scratch.validate_startup(entry,node,dict(proof,**{key:value}))
    def test_reaper_refuses_attached_foreign_and_retained_disks(self):
        self.ctl.create('node-001')
        self.assertFalse(scratch.cleanup_volumes(self.config,base,self.api))
        self.assertEqual(self.api.deleted_volumes,[])
        self.api.volumes[0]['description']='foreign'
        self.ctl.remove('node-001')
        self.assertFalse(scratch.cleanup_volumes(self.config,base,self.api)); self.assertEqual(self.api.deleted_volumes,[])


class RemoteFormatTests(unittest.TestCase):
    def check(self,changes):
        cfg={'droplet_id':101,'name':'owned-scratch','filesystem_uuid':'11111111-1111-1111-1111-111111111111',
             'storage_kind':'cold-scratch','attachment_verified':True,'nonce':'a'*32,'format_intent_at':base.stamp()}
        answers={'curl':'101','blockdev':str(200*1024**3),'lsblk':'disk',
                 'findmnt':json.dumps({'filesystems':[]}), 'swapon':'','blkid':'foreign-uuid','wipefs':json.dumps({'signatures':[]})}
        answers.update(changes); calls=[]
        def output(args,**kwargs): return answers[args[0]]
        def run(args,**kwargs):
            calls.append(args)
            if args[0]=='mkfs.ext4': raise RuntimeError('FORMAT_BOUNDARY')
            if args[0]=='mount': raise RuntimeError('MOUNT_BOUNDARY')
            raise AssertionError(args)
        with mock.patch.object(subprocess,'check_output',side_effect=output),mock.patch.object(subprocess,'run',side_effect=run),\
             mock.patch.object(Path,'is_block_device',return_value=True),mock.patch.object(Path,'iterdir',return_value=iter([])),\
             mock.patch.object(Path,'mkdir'),\
             mock.patch.object(sys,'argv',['script',json.dumps(cfg)]):
            try: exec(scratch.INITIALIZE,{})
            except (AssertionError,RuntimeError) as error: return str(error),calls
        self.fail('initializer unexpectedly completed')
    def test_only_exact_owned_blank_device_reaches_format_boundary(self):
        error,calls=self.check({})
        self.assertEqual(error,'FORMAT_BOUNDARY'); self.assertEqual(calls[0][0],'mkfs.ext4')
    def test_prior_format_uuid_can_resume_without_formatting_again(self):
        error,calls=self.check({'wipefs':json.dumps({'signatures':[{'type':'ext4'}]}),
                                'blkid':'11111111-1111-1111-1111-111111111111'})
        self.assertEqual(error,'MOUNT_BOUNDARY')
        self.assertEqual([args[0] for args in calls],['mount'])

    def test_wrong_node_size_partition_mount_swap_or_signature_never_formats(self):
        cases=[{'curl':'102'},{'blockdev':'1024'},{'lsblk':'disk\npart'},
               {'swapon':'/dev/disk/by-id/scsi-0DO_Volume_owned-scratch'},
               {'findmnt':json.dumps({'filesystems':[{'source':'/dev/disk/by-id/scsi-0DO_Volume_owned-scratch','target':'/'}]})},
               {'findmnt':json.dumps({'filesystems':[{'source':'/dev/foreign','target':'/mnt/atomic-ci'}]})},
               {'wipefs':json.dumps({'signatures':[{'type':'ext4'}]})},
               {'wipefs':json.dumps({'signatures':[{'type':'gpt'}]})}]
        for changes in cases:
            with self.subTest(changes=changes):
                _,calls=self.check(changes); self.assertEqual(calls,[])


class ContainerdConfigTests(unittest.TestCase):
    def validate_dump(self, text):
        # Execute the shipped initializer's actual guard, not a second parser.
        module = ast.parse(scratch.INITIALIZE)
        guards = [node for node in module.body if isinstance(node, ast.Assert)
                  and any(isinstance(value, ast.List)
                          and [item.value for item in value.elts if isinstance(item, ast.Constant)]
                          == ['containerd', 'config', 'dump']
                          for value in ast.walk(node))]
        self.assertEqual(len(guards), 1)
        def output(args):
            self.assertEqual(args, ['containerd', 'config', 'dump'])
            return text
        exec(compile(ast.Module(body=guards, type_ignores=[]), '<actual-containerd-root-guard>', 'exec'),
             {'out': output, 'root': Path('/mnt/atomic-ci'), 'tomllib': tomllib})

    def test_semantically_identical_single_and_double_quoted_dump_roots_pass(self):
        for text in ('root = "/mnt/atomic-ci/containerd"\n',
                     "root = '/mnt/atomic-ci/containerd'\n",
                     "version = 3\nroot='/mnt/atomic-ci/containerd'\n[grpc]\naddress='/run/containerd/containerd.sock'\n"):
            with self.subTest(text=text): self.validate_dump(text)

    def test_foreign_root_rejected_even_if_comment_contains_expected_spelling(self):
        for text in ('root = "/var/lib/containerd"\n',
                     'root = "/var/lib/containerd"\n# root = "/mnt/atomic-ci/containerd"\n'):
            with self.subTest(text=text), self.assertRaises(AssertionError): self.validate_dump(text)


class InitializerOutputTests(unittest.TestCase):
    def run_setup(self, child_code):
        functions = [node for node in ast.parse(scratch.INITIALIZE).body
                     if isinstance(node, ast.FunctionDef) and node.name == 'run']
        self.assertEqual(len(functions), 1)
        source = 'import json,subprocess,sys\n' + ast.unparse(functions[0])
        source += '\nrun([sys.executable,"-c",' + repr(child_code) + '])'
        source += '\nprint(json.dumps({"mount_target":"/mnt/atomic-ci"}))\n'
        return subprocess.run([sys.executable, '-c', source], capture_output=True, text=True, timeout=10)

    def test_actual_setup_helper_keeps_progress_on_stderr_and_stdout_json_only(self):
        result = self.run_setup('import sys;print("format progress");print("device diagnostic",file=sys.stderr)')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'mount_target': '/mnt/atomic-ci'})
        self.assertIn('format progress', result.stderr)
        self.assertIn('device diagnostic', result.stderr)

    def test_actual_setup_helper_still_fails_closed_and_preserves_diagnostics(self):
        result = self.run_setup('import sys;print("setup failed",file=sys.stderr);sys.exit(7)')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('setup failed', result.stderr)
        self.assertIn('CalledProcessError', result.stderr)

if __name__=='__main__': unittest.main()
