#!/usr/bin/env python3
"""Fixed, source-pinned native/private recipes. Raw output never enters results."""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True
PROFILE = 'pr2621-native-private-v1'
GROUPS = {
    'native': ('native-build', 'native-clippy', 'native-peer', 'native-vault',
               'iroh-reopen', 'iroh-renderer', 'webrtc-renderer'),
    'private-vault': ('private-build', 'private-check', 'private-clippy', 'private-test',
                      'managed-check', 'managed-clippy', 'managed-test', 'vault-workspace'),
}
SHA = re.compile(r'[a-f0-9]{40}')
HASH = re.compile(r'[a-f0-9]{64}')


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, data):
    path = Path(path)
    if path.is_symlink() or any(p.is_symlink() for p in path.parents):
        raise ValueError('unsafe supplemental evidence path')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    with temporary.open('x') as stream:
        json.dump(data, stream, indent=2)
        stream.write('\n')
    temporary.replace(path)


def remaining(config):
    deadline = dt.datetime.fromisoformat(config['deadline'].replace('Z', '+00:00'))
    if deadline.utcoffset() is None:
        raise ValueError('supplemental deadline must be timezone aware')
    seconds = (deadline - dt.datetime.now(dt.timezone.utc)).total_seconds()
    if seconds <= 0:
        raise TimeoutError('original supplemental deadline reached')
    return seconds


def validate_phase(config):
    if config.get('supplemental_profile') != PROFILE or config.get('group') not in GROUPS:
        raise ValueError('unsupported supplemental profile or group')
    for key in ('source_commit',):
        if not isinstance(config.get(key), str) or not SHA.fullmatch(config[key]):
            raise ValueError('invalid supplemental source pin')
    for key in ('batch_key', 'node_id'):
        if not isinstance(config.get(key), str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', config[key]):
            raise ValueError('invalid supplemental identity')
    root = Path(config.get('private_root', ''))
    expected_root = Path('/mnt/atomic-ci/private') / config['batch_key'] / config['node_id'] / config['group']
    if root != expected_root or root.is_symlink() or any(p.is_symlink() for p in root.parents):
        raise ValueError('supplemental private root is not isolated')
    if type(config.get('jobs', 16)) is not int or not 1 <= config.get('jobs', 16) <= 32:
        raise ValueError('invalid supplemental compile budget')
    requested = config.get('server_workers', 0)
    if type(requested) is not int or not 0 <= requested <= 128:
        raise ValueError('invalid supplemental HTTP budget')
    remaining(config)
    return config


# These are fixed recipes, never operator-provided shell commands. The ordinary
# public CI checkout is not mounted; each group owns a source-matching sibling pair.
FRONTEND = '''pnpm -C browser install --frozen-lockfile
pnpm -C browser --filter @tomic/lib --filter @tomic/react --filter @tomic/plugin --filter @tomic/service-ui --filter @tomic/form-renderer --filter @tomic/form-app --filter @tomic/edit-mode run build
pnpm -C browser/data-browser build:wasm
pnpm -C browser/data-browser exec vite build
(cd ../atomic-saas/portal && npm ci && npm run build)
'''
PEER_BUILD = '''cargo test --locked -p atomic_lib --features db-redb,iroh --test {target} --no-run --message-format=json > /tmp/{target}.json
binary=$(python3 -c 'import json; a=[x["executable"] for l in open("/tmp/{target}.json") if (x:=json.loads(l)).get("executable") and x.get("target",{{}}).get("name")=="{target}"]; assert len(a)==1; print(a[0])')
test -x "$binary"
'''
RECIPES = {
    'native-build': '''node --experimental-vm-modules --test desktop/scripts/native-recovery/run.test.mjs
rustup target add wasm32-wasip2
NATIVE_RECOVERY_BUILD_ONLY=true bash desktop/scripts/native-recovery/build-and-test.sh
cargo build --locked -p atomic-server
TAURI=1 pnpm -C browser/data-browser exec vite build -c vite.embed.config.ts
pnpm -C browser/e2e exec playwright install --with-deps chromium''',
    'native-clippy': 'cargo clippy --locked -p atomic-server-tauri --features native-recovery-tests --all-targets -- -D warnings',
    'native-peer': 'NATIVE_RECOVERY_CASE=peer dbus-run-session -- xvfb-run -a node desktop/scripts/native-recovery/run.mjs',
    'native-vault': 'NATIVE_RECOVERY_CASE=vault dbus-run-session -- xvfb-run -a node desktop/scripts/native-recovery/run.mjs',
    'iroh-reopen': PEER_BUILD.format(target='iroh_receipts') + '"$binary" automatic_bulk_and_live_receipts_survive_receiver_reopen --exact --nocapture --test-threads=1',
    'iroh-renderer': PEER_BUILD.format(target='iroh_receipts') + '''TAURI=1 pnpm -C browser/data-browser exec vite build -c vite.embed.config.ts
pnpm -C browser/e2e exec playwright install --with-deps chromium
ATOMIC_NATIVE_EMBED_TEST_BINARY="$binary" pnpm -C browser/e2e exec playwright test tests/native-resource-peer-sync.spec.ts --project=chromium --workers=1 --retries=0 --reporter=json > /artifacts/iroh-renderer.json''',
    'webrtc-renderer': PEER_BUILD.format(target='webrtc_receipts') + '''ATOMIC_NATIVE_WEBRTC_TEST_BINARY="$binary" ATOMIC_SUPPLEMENTAL_BROWSER_CASE=webrtc node /code/vault-fixture.mjs''',
    'private-build': 'rustup target add wasm32-wasip2\n' + FRONTEND + '''cargo build --locked -p atomic-server
(cd ../atomic-saas && cargo build --locked --workspace --bins)
pnpm -C browser/e2e exec playwright install --with-deps chromium''',
    'private-check': 'cd ../atomic-saas && cargo check --locked --all-targets',
    'private-clippy': 'cd ../atomic-saas && cargo clippy --locked --all-targets -- -D warnings',
    'private-test': 'cd ../atomic-saas && cargo test --locked --all-targets',
    'managed-check': 'cd ../atomic-saas && cargo check --locked -p atomic-managed-node --all-targets',
    'managed-clippy': 'cd ../atomic-saas && cargo clippy --locked -p atomic-managed-node --all-targets -- -D warnings',
    'managed-test': 'cd ../atomic-saas && cargo test --locked -p atomic-managed-node --all-targets',
    'vault-workspace': 'node /code/vault-fixture.mjs',
}

VAULT_FIXTURE = r'''import { RecoveryContext } from '/code/atomic-server/desktop/scripts/native-recovery/support.mjs';
import { startStorage } from '/code/atomic-server/desktop/scripts/native-recovery/storage.mjs';
const selected = process.env.ATOMIC_SUPPLEMENTAL_BROWSER_CASE ?? 'vault';
if (!['vault','webrtc'].includes(selected)) throw new Error('Unknown supplemental browser case');
const spec = selected==='vault' ? 'vault-backup-restore.spec.ts' : 'native-webrtc-resource-sync.spec.ts';
const output = selected==='vault' ? 'vault-workspace' : 'webrtc-renderer';
const ctx = await new RecoveryContext().init();
try {
  await startStorage(ctx);
  await ctx.spawn('/code/atomic-server/target/debug/atomic-server', [], {env:{
    ATOMIC_INITIALIZE:'true', ATOMIC_IP:'127.0.0.1', ATOMIC_DOMAIN:'localhost', ATOMIC_PORT:'9883',
    ATOMIC_DATA_DIR:ctx.runDir+'/server/data', ATOMIC_CONFIG_DIR:ctx.runDir+'/server/config',
    ATOMIC_CACHE_DIR:ctx.runDir+'/server/cache', SENTRY_DSN:'', SENTRY_DSN_BROWSER:''}});
  await ctx.wait('matching local server readiness', async()=>{
    try {return (await fetch('http://localhost:9883/setup')).ok;} catch{return false;}
  });
  const child = await ctx.spawn('pnpm',['exec','playwright','test','tests/'+spec,
    '--project=chromium','--workers=1','--retries=0','--reporter=json'], {
    cwd:'/code/atomic-server/browser/e2e', env:{ATOMIC_VAULT_PORTAL_URL:'http://localhost:3031',
      FRONTEND_URL:'http://localhost:9883', SERVER_URL:'http://localhost:9883'}});
  // Preserve raw JSON privately for the outer allowlisted-count projection.
  const { createWriteStream } = await import('node:fs');
  const out = createWriteStream('/artifacts/'+output+'.json',{mode:0o600});
  child.stdout.pipe(out);
  const result = await child.finished;
  await new Promise(resolve=>out.end(resolve));
  process.exitCode = result.code === 0 ? 0 : 1;
} finally { await ctx.cleanup(); }
'''


def report_count(path, expected, filename=None):
    """Strict native opt-in acceptance: no silent skips, retries or global errors."""
    value = json.loads(Path(path).read_text())
    found = []
    identities = set()
    def walk(suites):
        for suite in suites:
            for spec in suite.get('specs', []):
                if filename is not None:
                    if not str(spec.get('file', '')).endswith('/'+filename) and spec.get('file') != filename:
                        raise ValueError('supplemental browser selected another file')
                    identity = (spec.get('file'), spec.get('line'), spec.get('title'))
                    if identity in identities:
                        raise ValueError('supplemental browser duplicated a case')
                    identities.add(identity)
                found.extend(spec.get('tests', []))
            walk(suite.get('suites', []))
    walk(value.get('suites', []))
    if value.get('errors') or len(found) != expected:
        raise ValueError('required supplemental browser inventory differs')
    for test in found:
        runs = test.get('results', [])
        if (test.get('status') != 'expected' or test.get('expectedStatus') != 'passed'
                or len(runs) != 1 or runs[0].get('status') != 'passed' or runs[0].get('retry', 0) != 0):
            raise ValueError('required supplemental browser case did not pass once')
    return expected


class Driver:
    def __init__(self, config, execute=None):
        self.config = validate_phase(config)
        self.root = Path(config['private_root'])
        self.repo = Path('/opt/atomic-ci/repo')
        self.execute = execute or self.command
        self.container = 'aci-' + config['batch_key'] + '-' + config['node_id'] + '-' + config['group']
        self.image = self.container + '-env'
        self.code = self.root / 'code'
        self.artifacts = self.root / 'artifacts'
        self.raw = self.root / 'logs'
        self.image_id = None

    def command(self, args, log, capture=False):
        seconds = remaining(self.config) if 'cleanup' not in log.name else 20
        log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
            result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=output,
                                    stderr=subprocess.STDOUT, timeout=seconds,
                                    env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': '/root'})
        return result.returncode, log.read_text() if capture else ''

    def call(self, args, name, capture=False):
        return self.execute(args, self.raw / (name + '.log'), capture)

    def prepare(self):
        if self.root.exists():
            raise ValueError('supplemental private workspace already exists')
        self.root.mkdir(parents=True, mode=0o700)
        self.code.mkdir(mode=0o700)
        self.artifacts.mkdir(mode=0o700)
        self.raw.mkdir(mode=0o700)
        capsule = load('ci-fanout-private-input')
        capsule.verify_capsule(self.config['private_input'])
        capsule.extract_capsule(self.config['private_input'], self.code / 'atomic-saas')
        code, _ = self.call(['git', 'clone', '--no-hardlinks', '--no-checkout', str(self.repo), str(self.code / 'atomic-server')], 'public-clone')
        if code:
            raise ValueError('supplemental public source clone failed')
        code, _ = self.call(['git', '-C', str(self.code / 'atomic-server'), 'checkout', '--detach', self.config['source_commit']], 'public-checkout')
        if code:
            raise ValueError('supplemental public pin checkout failed')
        (self.code / 'vault-fixture.mjs').write_text(VAULT_FIXTURE)
        code, _ = self.call(['docker', 'build', '--tag', self.image, '--file', str(self.code / 'atomic-server/desktop/native-recovery.Dockerfile'), str(self.code / 'atomic-server')], 'environment-build')
        if code:
            return False
        code, text = self.call(['docker', 'image', 'inspect', '--format', '{{.Id}}', self.image], 'environment-identity', True)
        if code or not re.fullmatch(r'sha256:[a-f0-9]{64}', text.strip()):
            raise ValueError('supplemental environment identity missing')
        self.image_id = text.strip()
        return True

    def start(self):
        jobs = str(self.config.get('jobs', 16))
        env = {'CI':'true', 'ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME':'true', 'CARGO_BUILD_JOBS':jobs, 'CARGO_TARGET_DIR':'/code/atomic-server/target',
               'CARGO_BUILD_BUILD_DIR':'/code/atomic-server/target/build', 'VITE_E2E':'true',
               'VITE_ATOMIC_SERVER_URL':'http://localhost:9883', 'VITE_MANAGED_PORTAL_URL':'http://localhost:3031',
               'VITE_MANAGED_API_BASE':'http://localhost:3031/api', 'VITE_ATOMIC_APP_URL':'http://localhost:9883',
               'VITE_SENTRY_DSN':'', 'SENTRY_DSN':'', 'SENTRY_DSN_BROWSER':'', 'ATOMIC_SAAS_LOAD_DEV_ENV':'',
               'NATIVE_RECOVERY_BIN_DIR':'/code/atomic-server/target/debug',
               'NATIVE_RECOVERY_SAAS_BINARY':'/code/atomic-server/target/debug/atomic-saas',
               'NATIVE_RECOVERY_ARTIFACT_DIR':'/artifacts', 'FRONTEND_URL':'http://localhost:9883',
               'SERVER_URL':'http://localhost:9883', 'ATOMIC_SAAS_ENABLE_PROVISIONING':'false'}
        requested = self.config.get('server_workers', 0)
        if requested:
            env['ATOMIC_HTTP_WORKERS'] = str(requested)
        args = ['docker','run','--detach','--init','--name',self.container,'--label','atomic-ci-batch='+self.config['batch_key'],
                '--label','atomic-ci-source='+self.config['source_commit'],'--shm-size=1g','--cpus',jobs,'--memory=64g',
                '--mount','type=bind,src='+str(self.code)+',dst=/code',
                '--mount','type=bind,src='+str(self.artifacts)+',dst=/artifacts']
        for key, value in env.items():
            args += ['--env', key+'='+value]
        args += [self.image_id, 'sleep','infinity']
        code, _ = self.call(args, 'container-start')
        if code:
            raise ValueError('supplemental container startup failed')

    def run_case(self, name):
        code, _ = self.call(['docker','exec','--workdir','/code/atomic-server',self.container,
                             'bash','-euo','pipefail','-c',RECIPES[name]], name)
        count = None
        if code == 0 and name in ('iroh-renderer', 'webrtc-renderer', 'vault-workspace'):
            try:
                filenames = {'iroh-renderer':'native-resource-peer-sync.spec.ts',
                    'webrtc-renderer':'native-webrtc-resource-sync.spec.ts',
                    'vault-workspace':'vault-backup-restore.spec.ts'}
                count = report_count(self.artifacts / (name+'.json'), 2 if name == 'vault-workspace' else 1, filenames[name])
            except (OSError, ValueError, TypeError, KeyError):
                code = 1
        if code == 0 and name in ('native-peer','native-vault'):
            summaries = [json.loads(p.read_text()) for p in self.artifacts.glob('*/summary.json')]
            wanted = name.removeprefix('native-')
            if not any(s.get('passed') is True and s.get('selectedCase') == wanted for s in summaries):
                code = 1
        if code == 0 and name == 'iroh-reopen':
            if not re.search(r'test result: ok\. 1 passed; 0 failed;', (self.raw / (name+'.log')).read_text()):
                code = 1
        return {'id':name, 'status':'passed' if code == 0 else 'failed', 'exit_code':code,
                'browser_passed':count, 'finished_at':stamp()}

    def cleanup(self):
        # An inspect error is not proof that our known-started container is gone.
        code, text = self.call(['docker','inspect','--format','{{json .Config.Labels}}',self.container], 'container-cleanup-identity', True)
        if code:
            code, text = self.call(['docker','ps','--all','--filter','name=^/'+self.container+'$',
                                    '--format','{{.ID}}'], 'container-cleanup-absence', True)
            if code or text.strip():
                raise ValueError('supplemental container absence cannot be verified')
            return
        labels = json.loads(text)
        if labels.get('atomic-ci-batch') != self.config['batch_key'] or labels.get('atomic-ci-source') != self.config['source_commit']:
            raise ValueError('supplemental cleanup container ownership differs')
        self.call(['docker','rm','--force',self.container], 'container-cleanup')
        code, text = self.call(['docker','ps','--all','--filter','name=^/'+self.container+'$',
                                '--format','{{.ID}}'], 'container-cleanup-absence', True)
        if code or text.strip():
            raise ValueError('supplemental container deletion absence cannot be verified')

    def publish_images(self, destination):
        """Only known synthetic native-recovery PNGs; no raw JSON/traces/logs."""
        destination = Path(destination)
        output = []
        for name in ('peer-recovered.png','vault-recovered.png'):
            matches = list(self.artifacts.glob('*/'+name))
            if not matches:
                continue
            if len(matches) != 1:
                raise ValueError('supplemental screenshot identity is ambiguous')
            source = matches[0]
            if source.is_symlink() or not source.is_file() or source.stat().st_size > 10*1024*1024:
                raise ValueError('supplemental screenshot is not a bounded regular PNG')
            with source.open('rb') as stream:
                if stream.read(8) != b'\x89PNG\r\n\x1a\n':
                    raise ValueError('supplemental screenshot is not PNG')
            destination.mkdir(parents=True,exist_ok=True,mode=0o700)
            if destination.is_symlink() or any(p.is_symlink() for p in destination.parents):
                raise ValueError('unsafe supplemental screenshot destination')
            target = destination/name
            with source.open('rb') as src, target.open('xb') as out:
                shutil.copyfileobj(src,out)
            output.append({'name':name,'sha256':digest(target),'size':target.stat().st_size})
        return output

    def verify_sources(self):
        public = self.code / 'atomic-server'
        code, text = self.call(['git','-C',str(public),'status','--porcelain=v1','--untracked-files=no'], 'public-final-integrity', True)
        if code or text.strip():
            raise ValueError('supplemental build modified pinned public source')
        private_manifest = {item['path']: item for item in json.loads(Path(self.config['private_input']['manifest_path']).read_text())['files']}
        private = self.code / 'atomic-saas'
        for name, item in private_manifest.items():
            target = private / name
            if target.is_symlink() or not target.is_file() or digest(target) != item['sha256']:
                raise ValueError('supplemental build modified pinned private source')
    def run(self):
        began = stamp()
        cases = []
        started = False
        prepared = self.prepare()
        try:
            if prepared:
                self.start()
                started = True
            build = GROUPS[self.config['group']][0]
            build_passed = False
            for name in GROUPS[self.config['group']]:
                if not prepared or name != build and not build_passed:
                    result = {'id':name,'status':'blocked','exit_code':None,'browser_passed':None,'finished_at':stamp()}
                else:
                    result = self.run_case(name)
                cases.append(result)
                if name == build:
                    build_passed = result['status'] == 'passed'
        finally:
            if started:
                self.cleanup()
        self.verify_sources()
        return {'version':1, 'profile':PROFILE, 'batch_key':self.config['batch_key'],
                'node_id':self.config['node_id'], 'group':self.config['group'],
                'source_commit':self.config['source_commit'], 'private_source_commit':self.config['private_input']['source_commit'],
                'private_archive_sha256':self.config['private_input']['archive_sha256'],
                'private_manifest_sha256':self.config['private_input']['manifest_sha256'],
                'image_id':self.image_id, 'started_at':began, 'finished_at':stamp(), 'cases':cases,
                'status':'passed' if all(c['status']=='passed' for c in cases) else 'failed',
                'completed':True,'artifacts':[]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    def stop(signum, frame):
        raise KeyboardInterrupt('supplemental phase interrupted')
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, stop)
    try:
        driver = Driver(config)
        receipt = driver.run()
        receipt['artifacts'] = driver.publish_images(args.receipt.parent/'artifacts')
        write_json(args.receipt, receipt)
        print('Supplemental group completed; sanitized receipt retained.')
        return 0 if receipt['status']=='passed' else 1
    except BaseException:
        # Never serialize raw exception messages, subprocess output or private paths.
        print('Supplemental setup, integrity or cleanup failed.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
