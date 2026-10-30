from pathlib import Path
import os,subprocess,json,shutil,hashlib
root=Path(os.environ.get('BENCH_PROFILE_ROOT', '/tmp/atomic-envelope-profile'))
binary=root/'profile'
r={'revision':'f570405eb2ff14570ca26d4e91e82e5dafd338b5','date':'2026-10-30','profile':'e2e, opt-level=2, lto=false, codegen-units=16, debug assertions on','binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'scope':'Receiver-only temporary foreground elapsed-time probes on the native batched envelope importer. Includes nested calls and waits; category times are inclusive and must not be summed. Normal 100 ms periodic durable flushing is active; thread-local probes record receiver foreground elapsed time, including waits. Excludes network, TLS and browser/OPFS. Same synthetic half-ProseMirror/half-properties fixture as PR2415.','rows':[]}
for n in [1000,5000,10000]:
 for label in ['control-before','profile-1','profile-2','control-after']:
  receiver=root/f'receiver-{n}-{label}'
  env=dict(os.environ,BENCH_DIR=str(Path(os.environ.get('BENCH_FIXTURE_ROOT', '/tmp/atomic-sync-comparison')) / f'fixture-{n}'),BENCH_RUN=str(receiver))
  if label.startswith('profile'):env['BENCH_PROFILE']='1'
  else:env.pop('BENCH_PROFILE',None)
  result=subprocess.run([str(binary)],env=env,capture_output=True,text=True)
  if result.returncode:
   print(result.stdout,result.stderr,flush=True)
   raise RuntimeError(f'{n} {label} failed')
  row=json.loads(result.stdout)
  row['label']=label
  r['rows'].append(row)
  (root/'results.json').write_text(json.dumps(r,indent=2)+'\n')
  print(n,label,round(row['receiverSeconds'],4),round(row['searchableSeconds'],4),flush=True)
  shutil.rmtree(receiver)
