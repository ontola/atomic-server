from pathlib import Path
import os,subprocess,json,shutil,hashlib
root=Path(os.environ.get('BENCH_PROFILE_ROOT', '/tmp/atomic-envelope-profile'))
r={'revision':'f570405eb2ff14570ca26d4e91e82e5dafd338b5','scope':'Exact frozen SYNC_PUSH frame replay into fresh file-backed receivers. Sender reconcile, startup, reading frames, compilation and post-search state/envelope/reopen verification excluded. Both diagnostic binaries retain inactive probes; profile samples enable them explicitly.','binaries':{k:hashlib.sha256((root/f'frozen-{k}').read_bytes()).hexdigest() for k in ['baseline','borrow']},'framesSha256':{str(n):hashlib.sha256((root/f'frames-{n}.json').read_bytes()).hexdigest() for n in [1000,5000,10000]},'rows':[]}
def sample(n,label,pair,profile=False):
 receiver=root/f'trial-{n}-{pair}-{label}'
 env=dict(os.environ,BENCH_DIR=str(Path(os.environ.get('BENCH_FIXTURE_ROOT', '/tmp/atomic-sync-comparison')) / f'fixture-{n}'),BENCH_RUN=str(receiver),BENCH_FRAMES=str(root/f'frames-{n}.json'))
 if profile:env['BENCH_PROFILE']='1'
 else:env.pop('BENCH_PROFILE',None)
 result=subprocess.run([str(root/f'frozen-{label}')],env=env,capture_output=True,text=True)
 if result.returncode:
  print(result.stdout,result.stderr,flush=True);raise RuntimeError(f'{n} {label} failed')
 row=json.loads(result.stdout);row.update(label=label,pair=pair,profileEnabled=profile)
 r['rows'].append(row)
 (root/'trial.json').write_text(json.dumps(r,indent=2)+'\n')
 print(n,pair,label,'profile' if profile else 'timed',round(row['receiverSeconds'],4),round(row['searchableSeconds'],4),flush=True)
 shutil.rmtree(receiver)
for label in ['baseline','borrow']: sample(1000,label,0,True)
for n in [5000,10000]:
 for pair in range(4):
  for label in (['baseline','borrow'] if pair%2==0 else ['borrow','baseline']):sample(n,label,pair)
for label in ['baseline','borrow']:sample(10000,label,4,True)
