#!/usr/bin/env python3
"""Owned blank scratch disks for cold CI. Never restores or formats a snapshot."""
from __future__ import annotations
import argparse
import datetime as dt
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
VOLUME_GIB = 200


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path, value):
    temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def validate_config(config, base):
    config = base.validate_config(dict(config))
    if type(config.get('cold_scratch_gib')) is not int or config['cold_scratch_gib'] != VOLUME_GIB:
        raise ValueError('cold_scratch_gib must be exactly 200')
    if config.get('cloud_worker_mode', 'cold') != 'cold' or any(k in config for k in (
            'source_snapshots', 'source_snapshot_id', 'source_snapshot_name', 'source_snapshot_profile')):
        raise ValueError('cold scratch cannot restore or format warm snapshots')
    if config['max_hours'] > 1 or config['max_total_usd'] > 7.5:
        raise ValueError('scratch is bounded to one hour and $7.50')
    if len(config['accounts']) != 1 or config['accounts'][0]['nodes'] != 3 or not re.fullmatch(r'[a-z][a-z0-9-]{0,40}', config['batch_key']):
        raise ValueError('scratch requires one account and a short lowercase batch key')
    for key in ('expected_hourly_rate', 'expected_scratch_volume_hourly_rate', 'max_total_usd'):
        value = config.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError('scratch requires positive explicit ' + key)
    if not isinstance(config.get('authorization'), str) or not config['authorization'].strip():
        raise ValueError('scratch requires the current authorization')
    total = sum(a['nodes'] for a in config['accounts'])
    if total * (config['expected_hourly_rate'] + config['expected_scratch_volume_hourly_rate']) * config['max_hours'] > config['max_total_usd']:
        raise ValueError('scratch compute and storage exceed the budget')
    return config


def owned_volume(volume, entry, node, config):
    try:
        account = config['accounts'][0]
        return (entry['storage_kind'] == 'cold-scratch' and entry['batch_key'] == config['batch_key']
            and entry['source_commit'] == config['source_commit'] and entry['absence_verified'] is True
            and entry['node_id'] == node['id'] and node['account'] == account['context'] == entry['account']
            and entry['expected_uuid'] == account['expected_uuid']
            and entry['name'] == node['name'] + '-scratch' == volume['name']
            and entry['description'] == 'Atomic CI scratch ' + config['batch_key'] + ' ' + entry['nonce']
            and re.fullmatch(r'[a-f0-9]{32}', entry['nonce']) is not None
            and re.fullmatch(r'[a-f0-9-]{36}', str(volume['id'])) is not None
            and volume['description'] == entry['description'] and volume['size_gigabytes'] == VOLUME_GIB
            and volume['region']['slug'] == config['region'] and volume.get('snapshot_id') in (None, '')
            and (not entry.get('id') or volume['id'] == entry['id'])
            and volume['id'] != config.get('cloud_volume_id')
            and dt.datetime.fromisoformat(volume['created_at'].replace('Z', '+00:00')) >=
                dt.datetime.fromisoformat(entry['attempted_at']) - dt.timedelta(seconds=2))
    except (KeyError, TypeError, ValueError):
        return False


# Executed only after the controller verifies exact provider attachment. All
# destructive inputs are node-specific JSON over the authenticated SSH channel.
INITIALIZE = r'''
import json,os,pathlib,subprocess,sys
cfg=json.loads(sys.argv[1]); root=pathlib.Path('/mnt/atomic-ci')
import re,datetime
assert cfg['storage_kind']=='cold-scratch' and cfg['attachment_verified'] is True
assert re.fullmatch(r'[a-f0-9]{32}',cfg['nonce']) and re.fullmatch(r'[a-f0-9-]{36}',cfg['filesystem_uuid'])
assert datetime.datetime.fromisoformat(cfg['format_intent_at']).utcoffset() is not None
def out(args): return subprocess.check_output(args,text=True).strip()
def run(args): subprocess.run(args,check=True)
assert out(['curl','-fsS','http://169.254.169.254/metadata/v1/id'])==str(cfg['droplet_id'])
assert not root.is_symlink() and root.resolve()==root
dev='/dev/disk/by-id/scsi-0DO_Volume_'+cfg['name']; real=os.path.realpath(dev)
assert pathlib.Path(real).is_block_device()
assert int(out(['blockdev','--getsize64',dev]))==200*1024**3
# A whole, unused block device only; never root, a partition, swap or held disk.
assert out(['lsblk','-n','-o','TYPE',dev])=='disk'
assert not list(pathlib.Path('/sys/class/block',pathlib.Path(real).name,'holders').iterdir())
mounts=json.loads(out(['findmnt','--json','--output','SOURCE,TARGET']))['filesystems']
def mounted(items):
 for item in items:
  if os.path.realpath(item.get('source','').split('[')[0])==real: yield item['target']
  yield from mounted(item.get('children',[]))
def flatten(items):
 for item in items:
  yield item
  yield from flatten(item.get('children',[]))
assert all(os.path.realpath(item.get('source','').split('[')[0])==real for item in flatten(mounts) if item.get('target')==str(root))
places=list(mounted(mounts)); assert not places or places==[str(root)]
assert real not in out(['swapon','--noheadings','--raw','--show=NAME']).splitlines()
signatures=json.loads(out(['wipefs','--json','--no-act',dev])).get('signatures',[])
fsid=out(['blkid','-s','UUID','-o','value',dev]) if signatures else ''
if not signatures:
 assert not places
 run(['mkfs.ext4','-U',cfg['filesystem_uuid'],dev])
else:
 assert len(signatures)==1 and signatures[0]['type']=='ext4' and fsid==cfg['filesystem_uuid']
if not places and root.exists(): assert not any(root.iterdir())
root.mkdir(exist_ok=True)
if not places: run(['mount',dev,str(root)])
marker=root/'owner.json'; identity={k:cfg[k] for k in ('batch_key','node_id','id','nonce','filesystem_uuid')}
assert not marker.is_symlink()
if marker.exists(): assert json.loads(marker.read_text())==identity
else:
 marker.write_text(json.dumps(identity)); marker.chmod(0o600)
for name in ('docker','containerd','browser-bundles','work'):
 target=root/name; assert not target.is_symlink(); target.mkdir(exist_ok=True); assert target.resolve()==target
fstab=pathlib.Path('/etc/fstab'); line='UUID='+cfg['filesystem_uuid']+' /mnt/atomic-ci ext4 defaults 0 2'
if line not in fstab.read_text().splitlines():
 with fstab.open('a') as f: f.write(line+'\n')
for unit in ('docker','containerd'):
 drop=pathlib.Path('/etc/systemd/system')/(unit+'.service.d'); drop.mkdir(parents=True,exist_ok=True)
 (drop/'atomic-ci-storage.conf').write_text('[Unit]\nRequiresMountsFor=/mnt/atomic-ci\n[Service]\nExecStartPre=/usr/bin/mountpoint -q /mnt/atomic-ci\n')
pathlib.Path('/etc/docker').mkdir(exist_ok=True)
pathlib.Path('/etc/docker/daemon.json').write_text(json.dumps({'data-root':str(root/'docker')}))
pathlib.Path('/etc/containerd').mkdir(exist_ok=True)
# Keep default plugin settings, replacing only the top-level persistent root.
import re
text=out(['containerd','config','default'])
text,count=re.subn(r'(?m)^root\s*=.*$', 'root = "'+str(root/'containerd')+'"',text,count=1)
assert count==1
pathlib.Path('/etc/containerd/config.toml').write_text(text+'\n')
run(['systemctl','daemon-reload']); run(['systemctl','unmask','containerd.service','docker.service','docker.socket'])
run(['systemctl','enable','--now','containerd.service','docker.service'])
info=json.loads(out(['docker','info','--format','{{json .}}']))
assert info['DockerRootDir']==str(root/'docker')
import tomllib
assert tomllib.loads(out(['containerd','config','dump']))['root']==str(root/'containerd')
# Inspect all running containerd roots, including Docker-managed daemons.
containerd_roots=[]
for pid in out(['pgrep','-x','containerd']).splitlines():
 argv=pathlib.Path('/proc',pid,'cmdline').read_bytes().decode().split('\0')
 def option(flags):
  for index,arg in enumerate(argv):
   if arg in flags: return argv[index+1]
   for flag in flags:
    if arg.startswith(flag+'='): return arg[len(flag)+1:]
  return None
 actual=option(('--root','-r'))
 if not actual:
  config=option(('--config','-c')) or '/etc/containerd/config.toml'
  actual=tomllib.loads(pathlib.Path(config).read_text())['root']
 actual=pathlib.Path(actual)
 assert actual.is_absolute() and actual.resolve().is_relative_to(root) and actual.resolve()!=root
 containerd_roots.append(str(actual.resolve()))
assert containerd_roots
for target in {str(root/'docker'),str(root/'containerd'),*containerd_roots}:
 entry=json.loads(out(['findmnt','--json','--target',str(target),'--output','TARGET,SOURCE,FSTYPE']))['filesystems'][0]
 assert entry['target']==str(root) and os.path.realpath(entry['source'])==real and entry['fstype']=='ext4'
pathlib.Path('/var/cache/atomic-ci').mkdir(exist_ok=True)
link=pathlib.Path('/var/cache/atomic-ci/browser-bundles')
if link.exists() or link.is_symlink(): assert link.resolve()==root/'browser-bundles'
else: link.symlink_to(root/'browser-bundles')
pathlib.Path('/var/lib/atomic-ci-ready').touch()
print(json.dumps(dict(identity,device_realpath=real,mount_target=str(root),docker_root_dir=info['DockerRootDir'],containerd_root=str(root/'containerd'),containerd_roots=containerd_roots,docker_version=info['ServerVersion'],free_bytes=os.statvfs(root).f_bavail*os.statvfs(root).f_frsize)))
'''


def validate_startup(entry, node, proof):
    expected = {key: entry[key] for key in ('batch_key', 'node_id', 'id', 'nonce', 'filesystem_uuid')}
    if (any(proof.get(k) != v for k, v in expected.items()) or node['id'] != entry['node_id']
            or proof.get('mount_target') != '/mnt/atomic-ci' or proof.get('docker_root_dir') != '/mnt/atomic-ci/docker'
            or proof.get('containerd_root') != '/mnt/atomic-ci/containerd'
            or not isinstance(proof.get('device_realpath'), str) or not proof['device_realpath'].startswith('/dev/')
            or not isinstance(proof.get('containerd_roots'), list) or not proof['containerd_roots']
            or any(not isinstance(value, str) or not value.startswith('/mnt/atomic-ci/')
                   or '..' in Path(value).parts for value in proof['containerd_roots'])
            or type(proof.get('free_bytes')) is not int or proof['free_bytes'] < 10 * 1024**3):
        raise ValueError('scratch startup proof differs from the owned mounted storage')
    return proof


def controller_class(base, api_factory=None):
    factory = api_factory or base.DigitalOcean

    class ScratchAPI:
        def __init__(self, config):
            self.config = config
            self.root = Path(config['runtime_dir'])
            self.backend = factory(config['doctl_config'])
        @property
        def config_path(self): return self.backend.config_path
        @config_path.setter
        def config_path(self, value): self.backend.config_path = value
        def identity(self, account): return self.backend.identity(account)
        def guard(self):
            state = json.loads((self.root/'state.json').read_text())
            if state.get('stop_requested') or base.utcnow() >= dt.datetime.fromisoformat(state['deadline']):
                raise TimeoutError('scratch run stopped or reached its original deadline')
            return state
        def call(self, account, args):
            if args[:3] != ['compute','droplet','create']: return self.backend.call(account,args)
            if '--volumes' in args: raise ValueError('unrecorded scratch attachment')
            with (self.root/'scratch-volumes.lock').open('a') as lock:
                import fcntl
                fcntl.flock(lock,fcntl.LOCK_EX)
                state=self.guard(); nodes=[n for n in state['nodes'].values() if n['name']==args[3] and n['account']==account['context']]
                if len(nodes)!=1: raise ValueError('scratch create lacks one owned node')
                node=nodes[0]; name=node['name']+'-scratch'; path=self.root/'scratch-volumes.json'
                ledger=json.loads(path.read_text()) if path.exists() else {}
                if name in ledger: raise ValueError('scratch creation already attempted; reconcile instead')
                self.backend.identity(account)
                if any(v['name']==name for v in self.backend.call(account,['compute','volume','list'])):
                    raise ValueError('pre-existing scratch volume is not owned')
                self.backend.identity(account); self.guard()
                entry={'storage_kind':'cold-scratch','batch_key':self.config['batch_key'],'source_commit':self.config['source_commit'],
                    'node_id':node['id'],'account':account['context'],'expected_uuid':account['expected_uuid'],
                    'name':name,'nonce':uuid.uuid4().hex,'filesystem_uuid':str(uuid.uuid4()),'absence_verified':True,'attempted_at':base.stamp()}
                entry['description']='Atomic CI scratch '+self.config['batch_key']+' '+entry['nonce']
                ledger[name]=entry; write_json(path,ledger)
                self.guard()
                response=self.backend.raw(account,['compute','volume','create',name,'--region',self.config['region'],
                    '--size','200GiB','--desc',entry['description'],'--http-retry-max','0'])
                values=response if isinstance(response,list) else [response]
                if len(values)!=1 or not isinstance(values[0],dict) or not owned_volume(values[0],entry,node,self.config):
                    entry['creation_identity_error']=True; write_json(path,ledger); raise ValueError('scratch create response identity mismatch')
                volume=values[0]; entry.update(id=volume['id'],created_at=volume['created_at']); write_json(path,ledger)
            self.backend.identity(account); self.guard()
            base.Controller(self.config,api=self).node_update(node['id'],creation_attempted_at=base.stamp())
            self.guard()
            return self.backend.raw(account,[*args,'--volumes',volume['id']])

    class ScratchController(base.Controller):
        def __init__(self, config):
            config=validate_config(config,base)
            super().__init__(config,api=ScratchAPI(config))
        def plan(self):
            plan=super().plan(); rate=self.config['expected_scratch_volume_hourly_rate']
            account=self.config['accounts'][0]
            self.api.identity(account)
            expected={self.config['batch_key']+'-node-'+str(i).zfill(3)+'-scratch' for i in range(1,4)}
            if any(volume.get('name') in expected for volume in self.api.call(account,['compute','volume','list'])):
                raise ValueError('pre-existing expected-name scratch volume is not owned')
            plan.update(storage_mode='cold-scratch',scratch_volume_gib=200,
                scratch_storage_hourly_usd_estimate=plan['nodes']*rate)
            return plan
        def initialize(self, plan):
            super().initialize(plan); now=base.utcnow()
            deadline=now+dt.timedelta(hours=self.config['max_hours'])
            if self.config.get('absolute_deadline'): deadline=min(deadline,dt.datetime.fromisoformat(self.config['absolute_deadline'].replace('Z','+00:00')))
            self.update(lambda state:state.update(first_creation_at=now.isoformat(),deadline=deadline.isoformat()))
        def cloud_init(self, version):
            text=super().cloud_init(version)
            marker='  - [systemctl, enable, --now, docker]'
            if text.count(marker)!=1: raise ValueError('review changed Docker bootstrap before scratch use')
            text=text.replace('package_update: true','bootcmd:\n  - [systemctl, mask, docker.service, docker.socket, containerd.service]\npackage_update: true',1)
            text=text.replace(marker,'  - [true]')
            return text.replace('touch /var/lib/atomic-ci-ready','touch /var/lib/atomic-ci-storage-pending')
        def prepare(self,node_id):
            began=time.monotonic()
            while time.monotonic()-began<900:
                self.check_deadline(); node=self.read()['nodes'][node_id]; account=self.account(node['account'])
                result=self.api.call(account,['compute','droplet','get',str(node['droplet_id'])]); live=result[0] if isinstance(result,list) else result
                ips=[i['ip_address'] for i in live.get('networks',{}).get('v4',[]) if i['type']=='public']
                if live['status']=='active' and ips:
                    self.node_update(node_id,ip=ips[0])
                    try:
                        self.ssh(node_id,'test -f /var/lib/atomic-ci-storage-pending',timeout=20,first=True); break
                    except (RuntimeError,subprocess.TimeoutExpired): pass
                time.sleep(5)
            else: raise TimeoutError('scratch worker bootstrap unavailable')
            path=self.root/'scratch-volumes.json'; ledger=json.loads(path.read_text()); entry=ledger[node['name']+'-scratch']
            self.api.identity(account); listed=self.api.call(account,['compute','volume','list'])
            volume=next((v for v in listed if v.get('id')==entry['id']),None)
            if not volume or not owned_volume(volume,entry,node,self.config) or volume.get('droplet_ids')!=[node['droplet_id']]:
                raise ValueError('scratch volume is not attached to its exact owned worker')
            self.check_deadline()
            with (self.root/'scratch-volumes.lock').open('a') as lock:
                import fcntl
                fcntl.flock(lock,fcntl.LOCK_EX)
                ledger=json.loads(path.read_text()); entry=ledger[node['name']+'-scratch']
                entry.setdefault('format_intent_at',base.stamp()); write_json(path,ledger)
            cfg=dict(entry,droplet_id=node['droplet_id'],attachment_verified=True)
            proof=json.loads(self.ssh(node_id,'python3 -c '+shlex.quote(INITIALIZE)+' '+shlex.quote(json.dumps(cfg)),timeout=min(300,self.artifact_transfer_timeout())))
            validate_startup(entry,node,proof)
            local=self.root/node_id; local.mkdir(exist_ok=True); write_json(local/'scratch-startup.json',proof)
            self.node_update(node_id,scratch_startup_proof=proof)
            super().prepare(node_id)
        def cleanup(self,reason='manual cleanup',successful=False):
            try: super().cleanup(reason,successful)
            finally:
                try:
                    done=cleanup_volumes(self.config,base,self.api.backend)
                except BaseException:
                    self.update(lambda state:state.update(status='cleanup_failed',finished_at=None,cleanup_errors=[*state.get('cleanup_errors',[]),'scratch cleanup unavailable']))
                    raise
                if not done:
                    self.update(lambda state:state.update(status='cleanup_failed',finished_at=None,cleanup_errors=[*state.get('cleanup_errors',[]),'scratch cleanup pending']))
                    raise RuntimeError('scratch cleanup pending; inspect scratch-cleanup.json')
    return ScratchController


def cleanup_volumes(config,base,api=None):
    cloud=load('ci-fanout-cloud'); api=api or base.DigitalOcean(config['doctl_config'])
    # Base compute/key cleanup removes its frozen copy, not the boot-private original.
    api.config_path=config['doctl_config']
    root=Path(config['runtime_dir']); state=json.loads((root/'state.json').read_text()) if (root/'state.json').exists() else {'nodes':{}}
    account=config['accounts'][0]
    class Adapter:
        def identity(self): return api.identity(account)
        def volumes(self): return api.call(account,['compute','volume','list'])
        def volume(self,ident): return next((v for v in self.volumes() if v.get('id')==ident),None)
        def droplet(self,ident): return next((v for v in api.call(account,['compute','droplet','list']) if v.get('id')==ident),None)
        def delete_volume(self,ident): return api.call(account,['compute','volume','delete',ident,'--force','--http-retry-max','0'])
    wrapper={'fanout_config':config,'batch_key':config['batch_key'],'source_commit':config['source_commit'],
        'region':config['region'],'account':account,'volume':{'id':config.get('cloud_volume_id')},
        'expected_scratch_volume_hourly_rate':config['expected_scratch_volume_hourly_rate']}
    return cloud.reap_scratch_volumes(wrapper,Adapter(),state,base.utcnow())['all_deleted']


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('command',choices=('plan','run','status','cleanup','watchdog')); args=parser.parse_args()
    base=load('ci-fanout'); config=validate_config(json.loads(args.config.read_text()),base); ctl=controller_class(base)(config)
    if args.command=='plan': print(json.dumps(ctl.plan(),indent=2))
    elif args.command=='status': print(json.dumps(ctl.read(),indent=2))
    elif args.command=='cleanup': ctl.cleanup()
    elif args.command=='watchdog':
        while True:
            try:
                if ctl.path.exists():
                    done = ctl.watchdog_step()
                    if done and cleanup_volumes(config,base): return
                else:
                    time.sleep(1)
            except Exception as error: print('scratch watchdog will retry:',type(error).__name__,flush=True)
            time.sleep(5)
    else:
        ctl.root.mkdir(mode=0o700,parents=True,exist_ok=False)
        write_json(ctl.root/'config.json',config)
        with (ctl.root/'scratch-watchdog.log').open('ab') as log:
            watchdog=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--config',str(ctl.root/'config.json'),'watchdog'],start_new_session=True,stdout=log,stderr=subprocess.STDOUT)
        try: ctl.run()
        finally:
            if not ctl.path.exists() or (ctl.read().get('finished_at') and cleanup_volumes(config,base)):
                watchdog.terminate(); watchdog.wait(timeout=10)

if __name__=='__main__': main()
