#!/usr/bin/env python3
"""Fixed supplemental matrix composed over the reviewed cold scratch controller."""
from __future__ import annotations
import argparse
import datetime as dt
import importlib.util
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import sys

sys.dont_write_bytecode = True

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

SUPPLEMENTAL = load('ci-supplemental')
PROFILE = SUPPLEMENTAL.PROFILE
ASSIGNMENTS = {2:'native', 3:'private-vault'}


def validate_config(config, base):
    config = base.validate_config(dict(config))
    if (config.get('supplemental_profile') != PROFILE or config.get('check_only')
            or sum(account['nodes'] for account in config['accounts']) != 3
            or config.get('cold_scratch_gib') != 200 or config.get('source_snapshots')):
        raise ValueError('supplemental profile requires the complete three-node cold-scratch matrix')
    load('ci-fanout-private-input').verify_capsule(config['private_input'])
    jobs = config.setdefault('supplemental_jobs', 16)
    if type(jobs) is not int or not 1 <= jobs <= 32:
        raise ValueError('supplemental_jobs must be an integer from 1 to 32')
    return config


REQUIRED_SOURCE = (
    'desktop/native-recovery.Dockerfile', 'desktop/scripts/native-recovery/build-and-test.sh',
    'desktop/scripts/native-recovery/run.mjs', 'desktop/scripts/native-recovery/run.test.mjs',
    'desktop/scripts/native-recovery/peer.mjs',
    'desktop/scripts/native-recovery/vault.mjs', 'desktop/scripts/native-recovery/storage.mjs',
    'lib/tests/iroh_receipts.rs', 'lib/tests/webrtc_receipts.rs',
    'browser/e2e/tests/native-resource-peer-sync.spec.ts',
    'browser/e2e/tests/native-webrtc-resource-sync.spec.ts',
    'browser/e2e/tests/vault-backup-restore.spec.ts',
    'browser/data-browser/vite.embed.config.ts',
)


def source_capabilities(config, base):
    """Reject missing feature/runtime interfaces at the pin before allocation."""
    import hashlib
    bodies = {}
    hashes = {}
    paths = REQUIRED_SOURCE + (('scripts/ci-resource-sampler.py',) if config.get('sample_resources') else ())
    for path in paths:
        body = base.execute(['git','show',config['source_commit']+':'+path], cwd=config['worktree'])
        if isinstance(body,str):
            body = body.encode()
        bodies[path] = body.decode()
        hashes[path] = hashlib.sha256(body).hexdigest()
    markers = {
        'desktop/scripts/native-recovery/run.mjs': ('NATIVE_RECOVERY_CASE',),
        'desktop/scripts/native-recovery/build-and-test.sh': ('NATIVE_RECOVERY_BUILD_ONLY',),
        'lib/tests/iroh_receipts.rs': ('fn native_iroh_renderer_host()', 'NATIVE_HOST_READY'),
        'browser/e2e/tests/native-resource-peer-sync.spec.ts': ('native_iroh_renderer_host', 'ignored: true'),
    }
    if any(marker not in bodies[path] for path,required in markers.items() for marker in required):
        raise ValueError('pinned source lacks the required supplemental harness interfaces')
    return hashes


def verify_receipt(receipt, phase):
    """Allowlisted projection only. Never accept arbitrary private diagnostic fields."""
    expected = {'version':1, 'profile':PROFILE, 'batch_key':phase['batch_key'],
                'node_id':phase['node_id'], 'group':phase['group'], 'source_commit':phase['source_commit'],
                'private_source_commit':phase['private_input']['source_commit'],
                'private_archive_sha256':phase['private_input']['archive_sha256'],
                'private_manifest_sha256':phase['private_input']['manifest_sha256'], 'completed':True}
    allowed = set(expected) | {'image_id','started_at','finished_at','cases','status','artifacts'}
    if not isinstance(receipt, dict) or set(receipt) != allowed or any(receipt.get(k) != v for k,v in expected.items()):
        raise ValueError('supplemental receipt source/profile identity differs')
    cases = receipt['cases']
    if not isinstance(cases,list) or [case.get('id') for case in cases] != list(SUPPLEMENTAL.GROUPS[phase['group']]):
        raise ValueError('supplemental receipt required cases differ')
    for case in cases:
        if set(case) != {'id','status','exit_code','browser_passed','finished_at'}:
            raise ValueError('supplemental receipt contains unapproved case fields')
        code = case['exit_code']
        if (case['status'] not in ('passed','failed','blocked')
                or case['status']=='passed' and (type(code) is not int or code != 0)
                or case['status']=='failed' and (type(code) is not int or code <= 0)
                or case['status']=='blocked' and code is not None):
            raise ValueError('supplemental receipt case status/exit differs')
        count = case['browser_passed']
        if case['status']=='passed' and case['id'] in ('iroh-renderer','webrtc-renderer','vault-workspace'):
            if type(count) is not int or count != (2 if case['id']=='vault-workspace' else 1):
                raise ValueError('supplemental browser required count differs')
        elif count is not None:
            raise ValueError('supplemental receipt contains unapproved counts')
    artifacts = receipt['artifacts']
    if not isinstance(artifacts,list) or len(artifacts)>2:
        raise ValueError('supplemental artifact allowlist differs')
    names = []
    for artifact in artifacts:
        if (not isinstance(artifact,dict) or set(artifact)!={'name','sha256','size'}
                or artifact['name'] not in ('peer-recovered.png','vault-recovered.png')
                or not isinstance(artifact['sha256'],str) or not re.fullmatch(r'[a-f0-9]{64}',artifact['sha256'])
                or type(artifact['size']) is not int or not 8 <= artifact['size'] <= 10*1024*1024):
            raise ValueError('supplemental artifact is not an allowlisted PNG')
        names.append(artifact['name'])
    if len(names)!=len(set(names)):
        raise ValueError('supplemental artifact duplicated')
    passed = all(case['status']=='passed' for case in cases)
    if receipt['status'] != ('passed' if passed else 'failed'):
        raise ValueError('supplemental aggregate differs from its cases')
    if receipt['image_id'] is not None and not re.fullmatch(r'sha256:[a-f0-9]{64}', receipt['image_id']):
        raise ValueError('supplemental environment image identity invalid')
    if passed and receipt['image_id'] is None:
        raise ValueError('passing supplemental receipt lacks environment identity')
    began = dt.datetime.fromisoformat(receipt['started_at'])
    finished = dt.datetime.fromisoformat(receipt['finished_at'])
    deadline = dt.datetime.fromisoformat(phase['deadline'])
    if not began.utcoffset() == dt.timedelta(0) or not finished.utcoffset() == dt.timedelta(0) or not began <= finished <= deadline:
        raise ValueError('supplemental receipt timing differs from original deadline')
    for case in cases:
        at = dt.datetime.fromisoformat(case['finished_at'])
        if at.utcoffset() != dt.timedelta(0) or not began <= at <= finished:
            raise ValueError('supplemental case completion timing invalid')
    return receipt


def controller_class(base, parent=None):
    class NativeController(parent or base.Controller):
        def __init__(self, config, **kwargs):
            super().__init__(validate_config(config, base), **kwargs)

        def plan(self):
            capabilities = source_capabilities(self.config,base)
            result = super().plan()
            result['supplemental'] = {'profile':PROFILE, 'private_source_commit':self.config['private_input']['source_commit'],
                'archive_sha256':self.config['private_input']['archive_sha256'],
                'manifest_sha256':self.config['private_input']['manifest_sha256'],
                'jobs_per_supplemental_host':self.config['supplemental_jobs'],
                'source_capability_sha256':capabilities,
                'groups':{str(index):{'group':name,'required_cases':list(SUPPLEMENTAL.GROUPS[name])} for index,name in ASSIGNMENTS.items()}}
            return result

        def prepare(self, node_id):
            super().prepare(node_id)
            node = self.read()['nodes'][node_id]
            group = ASSIGNMENTS.get(node['shard_index'])
            if not group:
                return
            if not node.get('scratch_startup_proof'):
                raise ValueError('supplemental worker lacks verified scratch readiness')
            self.check_deadline()
            source = self.config['private_input']
            load('ci-fanout-private-input').verify_capsule(source)
            root = '/mnt/atomic-ci/private/'+self.config['batch_key']+'/'+node_id
            target = root+'/input'
            self.ssh(node_id, 'umask 077; mkdir -p '+shlex.quote(target)+'; test ! -L '+shlex.quote(target))
            self.scp(node_id, [Path(source['archive_path'])], target+'/source.tar')
            self.scp(node_id, [Path(source['manifest_path'])], target+'/manifest.json')
            descriptor = dict(source, archive_path=target+'/source.tar', manifest_path=target+'/manifest.json')
            self.node_update(node_id, supplemental_input=descriptor, supplemental_group=group,
                             supplemental_private_root=root+'/'+group)

        def phase_config_fields(self, node_id, name, kind):
            fields = super().phase_config_fields(node_id,name,kind)
            if kind != 'supplemental':
                return fields
            node = self.read()['nodes'][node_id]
            group = node.get('supplemental_group')
            if group not in SUPPLEMENTAL.GROUPS or name != 'supplemental-'+group:
                raise ValueError('supplemental phase assignment differs')
            return dict(fields, supplemental={'batch_key':self.config['batch_key'],'node_id':node_id,
                'source_commit':self.config['source_commit'], 'supplemental_profile':PROFILE, 'group':group,
                'private_input':node['supplemental_input'], 'private_root':node['supplemental_private_root'],
                'jobs':self.config['supplemental_jobs'], 'server_workers':self.config['server_workers'],
                'deadline':self.read()['deadline']})

        def verify_supplemental(self, node_id):
            local = self.retrieve(node_id)
            state = self.read()
            node = state['nodes'][node_id]
            phase_name = node['phase']
            result = node['phase_results'][phase_name]
            root = local/'results'/phase_name
            retrieved = json.loads((root/'result.json').read_text())
            if retrieved != result:
                raise ValueError('supplemental retrieved phase differs from observed result')
            path = root/'supplemental-receipt.json'
            receipt = verify_receipt(json.loads(path.read_text()), node['phase_config']['supplemental'])
            if result.get('supplemental_receipt_sha256') != base.file_sha256(path):
                raise ValueError('supplemental receipt hash differs from observed result')
            for artifact in receipt['artifacts']:
                image = root/'artifacts'/artifact['name']
                if image.is_symlink() or not image.is_file() or image.stat().st_size!=artifact['size'] or base.file_sha256(image)!=artifact['sha256']:
                    raise ValueError('supplemental retrieved screenshot differs')
            commands = result.get('commands', [])
            expected_exit = 0 if receipt['status']=='passed' else 1
            if result.get('status') != ('passed' if expected_exit==0 else 'failed'):
                raise ValueError('supplemental execution status differs from case receipts')
            if (not commands or any(type(item.get('exit_code')) is not int for item in commands)
                    or any(item['exit_code'] != 0 for item in commands[:-1]) or commands[-1]['exit_code'] != expected_exit):
                raise ValueError('supplemental execution exit differs from case receipts')
            self.node_update(node_id, supplemental_verified_at=base.stamp(), supplemental_receipt=receipt)
            return receipt

        def observe(self, node_id):
            try:
                return super().observe(node_id)
            except RuntimeError:
                node = self.read()['nodes'][node_id]
                result = node.get('phase_results', {}).get(node.get('phase'))
                if (node.get('phase_kind') != 'supplemental' or not result
                        or result.get('failure_scope') != 'completed-supplemental'
                        or result.get('status') != 'failed'):
                    raise
                receipt = self.verify_supplemental(node_id)
                if receipt['status'] != 'failed':
                    raise ValueError('failed supplemental phase claims a passing receipt')
                self.event(node_id+': supplemental checks failed; continuing independent work')
                return True

        def run_check_worker(self, node_id, pending):
            super().run_check_worker(node_id,pending)
            node = self.read()['nodes'][node_id]
            group = node.get('supplemental_group')
            if not group:
                return
            self.phase(node_id, 'supplemental-'+group, 'supplemental', [])
            self.wait([node_id])
            self.verify_supplemental(node_id)

        def validate_additional_results(self, nodes):
            super().validate_additional_results(nodes)
            state = self.read()
            statuses = {}
            for key in nodes:
                node = state['nodes'][key]
                group = ASSIGNMENTS.get(node['shard_index'])
                if not group:
                    continue
                receipt = node.get('supplemental_receipt')
                if not node.get('supplemental_verified_at') or not receipt or receipt.get('group') != group:
                    raise base.CIValidationFailure('required supplemental evidence is absent')
                verify_receipt(receipt, node['phase_config']['supplemental'] if node.get('phase_kind')=='supplemental'
                               else node['supplemental_phase_config'])
                statuses[group] = receipt['status']
            self.update(lambda value:value.update(supplemental_results=statuses, supplemental_completed_at=base.stamp()))
            if set(statuses) != set(SUPPLEMENTAL.GROUPS) or any(status!='passed' for status in statuses.values()):
                raise base.CIValidationFailure('required supplemental checks failed or were blocked')

        def phase(self, node_id, name, kind, args, **kwargs):
            super().phase(node_id,name,kind,args,**kwargs)
            if kind == 'supplemental':
                self.node_update(node_id, supplemental_phase_config=self.read()['nodes'][node_id]['phase_config']['supplemental'])

        def remove(self, node_id):
            node = self.read()['nodes'][node_id]
            if (not self.read().get('stop_requested') and ASSIGNMENTS.get(node['shard_index'])
                    and not node.get('supplemental_verified_at')):
                raise ValueError('required supplemental work must finish before early worker removal')
            return super().remove(node_id)
    return NativeController


def initialize_runtime_config(controller):
    """Watchdog and scheduler must freeze exactly the same normalized config."""
    controller.root.mkdir(parents=True,exist_ok=False,mode=0o700)
    path = controller.root/'config.json'
    path.write_text(json.dumps(controller.config))
    path.chmod(0o600)
    return controller.config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('command',choices=('plan','run','status','cleanup','watchdog'))
    args = parser.parse_args()
    base = load('ci-fanout')
    scratch = load('ci-fanout-scratch')
    config = json.loads(args.config.read_text())
    parent = scratch.controller_class(base)
    controller = (parent(config) if args.command in ('cleanup','watchdog')
                  else controller_class(base,parent)(config))
    if args.command=='plan':
        print(json.dumps(controller.plan(),indent=2))
    elif args.command=='run':
        config = initialize_runtime_config(controller)
        with (controller.root/'supplemental-watchdog.log').open('ab') as log:
            watchdog = subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--config',
                str(controller.root/'config.json'),'watchdog'],start_new_session=True,stdout=log,stderr=subprocess.STDOUT)
        try:
            controller.run()
        finally:
            if not controller.path.exists() or (controller.read().get('finished_at') and not controller.read().get('cleanup_errors')):
                watchdog.terminate()
                watchdog.wait(timeout=10)
    elif args.command=='status':
        print(json.dumps(controller.read(),indent=2))
    elif args.command=='cleanup':
        controller.cleanup('manual supplemental cleanup')
        scratch.cleanup_volumes(config,base)
    else:
        while True:
            try:
                if controller.path.exists() and controller.watchdog_step() and scratch.cleanup_volumes(config,base):
                    return
            except Exception:
                print('Supplemental cleanup watchdog will retry.',flush=True)
            time.sleep(5)


if __name__=='__main__':
    main()
