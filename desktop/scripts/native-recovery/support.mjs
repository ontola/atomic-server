import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { NativeBridge } from '../native-late-file-acceptance.mjs';

export const root = fileURLToPath(new URL('../../../', import.meta.url));

export class RecoveryContext {
  children = new Set();
  origin = 'http://localhost:9883';
  vaultOrigin = 'http://localhost:3031';
  peerPortalOrigin = 'http://127.0.0.1:49238';
  binDir = resolve(
    process.env.NATIVE_RECOVERY_BIN_DIR ?? join(root, 'target/debug'),
  );
  vaultDataDir = join(root, 'target/native-vault-acceptance/native-data');

  async init() {
    assert.equal(
      process.platform,
      'linux',
      'Run native recovery in its Linux container.',
    );
    process.umask(0o077);
    this.runDir = await mkdtemp(join(tmpdir(), 'atomic-native-recovery-'));
    this.artifactDir = join(
      resolve(
        process.env.NATIVE_RECOVERY_ARTIFACT_DIR ??
          join(root, 'target/native-recovery-ci/artifacts'),
      ),
      randomUUID(),
    );
    await mkdir(this.artifactDir, { recursive: true });
    await chmod(this.artifactDir, 0o755);

    // Refuse an overlapping run before moving even known test data. Container
    // ports stay internal; a host service never needs to be stopped for this.
    for (const port of [9883, 9223, 3031, 9101, 9102, 49238]) {
      await new Promise((resolveFree, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => server.close(resolveFree));
      });
    }

    // The offline fixture deliberately accepts one fixed path. Repeated runs
    // preserve the previous suite-owned data rather than reuse/delete it. Never
    // move a legacy or unknown directory just because it has the same name.
    try {
      assert(
        (await lstat(this.vaultDataDir)).isDirectory(),
        'Native fixture directory must not be a symlink.',
      );
      const ownerPath = join(this.vaultDataDir, 'NATIVE_RECOVERY_CI_ONLY');
      const ownerStat = await lstat(ownerPath);
      assert(
        ownerStat.isFile() &&
          ownerStat.uid === process.getuid() &&
          !(ownerStat.mode & 0o077),
      );
      assert.equal(
        JSON.parse(await readFile(ownerPath, 'utf8')).purpose,
        'native-recovery-ci',
      );
      await rename(
        this.vaultDataDir,
        join(dirname(this.vaultDataDir), `previous-${randomUUID()}`),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;

      // An existing data directory without our ownership marker is uncertain.
      try {
        await lstat(this.vaultDataDir);
        throw new Error(
          'Preserve existing native fixture data; use a fresh test volume.',
        );
      } catch (missing) {
        if (missing.code !== 'ENOENT') throw missing;
      }
    }

    await mkdir(this.vaultDataDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.vaultDataDir, 'NATIVE_RECOVERY_CI_ONLY'),
      JSON.stringify({ purpose: 'native-recovery-ci' }),
      { flag: 'wx', mode: 0o600 },
    );

    return this;
  }

  profileData(role) {
    return role === 'vault'
      ? this.vaultDataDir
      : join(this.runDir, role, 'data');
  }

  async spawn(
    command,
    args,
    { cwd = this.runDir, env = {}, logName = basename(command) } = {},
  ) {
    const log = createWriteStream(
      join(this.runDir, `${logName}-${randomUUID()}.log`),
      { mode: 0o600 },
    );
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    // Register immediately, including failed spawns. Never kill a process by name.
    this.children.add(child);
    child.finished = new Promise(resolveExit => {
      child.once('error', () => {
        log.end();
        resolveExit({ code: -1 });
      });
      child.once('close', (code, signal) => {
        log.end();
        resolveExit({ code, signal });
      });
    });

    return child;
  }

  async stopProcess(child) {
    if (!this.children.has(child))
      throw new Error('Refusing to stop an unowned process.');

    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }

      const exited = await Promise.race([
        child.finished.then(() => true),
        delay(5000).then(() => false),
      ]);

      if (!exited) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }

    await child.finished;
    this.children.delete(child);
  }

  async run(command, args, options) {
    const child = await this.spawn(command, args, options);
    let stdout = '';
    child.stdout.on('data', data => {
      stdout += data;
    });
    const result = await child.finished;
    this.children.delete(child);
    assert.equal(
      result.code,
      0,
      `${basename(command)} exited unsuccessfully (private log retained).`,
    );

    return stdout;
  }

  async wait(label, predicate, timeoutMs = 90_000) {
    this.stage = label;
    const until = Date.now() + timeoutMs;

    while (Date.now() < until) {
      if (
        this.appProcess &&
        (this.appProcess.exitCode !== null ||
          this.appProcess.signalCode !== null)
      )
        throw new Error(`Native app exited while waiting for ${label}.`);
      const value = await predicate();
      if (value) return value;
      await delay(200);
    }

    throw new Error(`Timed out waiting for ${label}.`);
  }

  async call(key, script, timeoutMs = 90_000) {
    this.stage = key;
    await this.app.launch(key, script);

    return (await this.app.poll(key, { timeoutMs })).value;
  }

  async startApp(role, { portalOrigin = this.vaultOrigin } = {}) {
    assert(!this.appProcess, 'Stop the previous app before launching another.');
    const profile = join(this.runDir, role);
    const dirs = {
      HOME: join(profile, 'home'),
      XDG_CONFIG_HOME: join(profile, 'xdg-config'),
      XDG_DATA_HOME: join(profile, 'xdg-data'),
      XDG_CACHE_HOME: join(profile, 'xdg-cache'),
      XDG_RUNTIME_DIR: join(profile, 'xdg-runtime'),
      ATOMIC_DATA_DIR: this.profileData(role),
      ATOMIC_CONFIG_DIR: join(profile, 'config'),
      ATOMIC_CACHE_DIR: join(profile, 'cache'),
    };
    for (const dir of Object.values(dirs))
      await mkdir(dir, { recursive: true, mode: 0o700 });
    this.profile = { role, portalOrigin, configDir: dirs.ATOMIC_CONFIG_DIR };
    this.appProcess = await this.spawn(
      join(this.binDir, 'atomic-server-tauri'),
      [
        '--initialize',
        '--port',
        '9883',
        '--domain',
        'localhost',
        '--ip',
        '127.0.0.1',
      ],
      {
        env: {
          ...dirs,
          ATOMIC_HOST_MODE: 'open',
          SENTRY_DSN: '',
          RUST_LOG: 'warn',
          // Software rendering is sufficient under Xvfb; do not disable WebKit's
          // security sandbox or replace WebCrypto for the test.
          LIBGL_ALWAYS_SOFTWARE: '1',
        },
        logName: `${role}-native`,
      },
    );
    await this.wait('native HTTP startup', async () => {
      try {
        return (await fetch(this.origin, { signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {
        return false;
      }
    });
    await this.wait('native diagnostic bridge', async () => {
      try {
        this.app = await NativeBridge.connect({ timeoutMs: 1000 });

        return true;
      } catch {
        return false;
      }
    });
    await this.wait('native Store', () =>
      this.app.evaluate('return !!window.store && !!window.__TAURI__;'),
    );
    await this.signIn();
  }

  async signIn() {
    const { configDir, portalOrigin } = this.profile;
    let secret;

    for (const file of await readdir(configDir)) {
      if (!file.endsWith('.toml')) continue;
      secret = (await readFile(join(configDir, file), 'utf8')).match(
        /^agent_secret\s*=\s*"([^"]+)"/m,
      )?.[1];
      if (secret) break;
    }

    assert(secret, 'Disposable native node did not create an agent key.');
    await this.app.evaluate(
      `window.__ATOMIC_MANAGED__={portalUrl:${JSON.stringify(portalOrigin)}};localStorage.setItem('atomic-managed-portal-url',${JSON.stringify(portalOrigin)});return true;`,
    );
    const identity = await this.wait('native identity initialization', () =>
      this.app.evaluate(`
        if(store.getAgent())return 'signed-in';
        var button=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='Sign in');
        if(button){button.click();return 'sign-in';}
        return null;
      `),
    );

    if (identity === 'sign-in') {
      await this.wait('normal agent-key input', () =>
        this.app.evaluate(
          `return !!document.querySelector('input[aria-label="Agent secret"]');`,
        ),
      );
      await this.app.evaluate(
        `var i=document.querySelector('input[aria-label="Agent secret"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(secret)});i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));i.blur();return true;`,
      );
    }

    await this.wait('completed native sign-in', () =>
      this.app.evaluate('return !!store.getAgent() && !!store.getDrive();'),
    );
    const native = await this.app.evaluate(
      'return {native:!!window.__TAURI__,clientDb:!!store.clientDb,secure:isSecureContext,crypto:!!crypto.subtle,agent:store.getAgent().subject};',
    );
    assert(
      native.native && !native.clientDb && native.secure && native.crypto,
      'Expected the real secure native WebView, not browser storage.',
    );
    // Derive the expected public identity outside the app. This does not replace
    // the WebView's normal WebCrypto/IndexedDB sign-in or native adoption.
    const { Agent } = await import(join(root, 'browser/lib/dist/index.js'));
    assert.equal(
      native.agent,
      Agent.fromSecret(secret, 'js').subject,
      'The WebView must sign in as the disposable native node agent.',
    );
  }

  async reload() {
    await this.app.evaluate(
      'setTimeout(()=>location.reload(),50);return true;',
    );
    await delay(500);
    await this.wait('reloaded native Store', () =>
      this.app.evaluate('return !!window.store && !!window.__TAURI__;'),
    );
    await this.signIn();
  }

  async stopApp() {
    if (!this.appProcess) return;

    try {
      await this.app?.evaluate(
        'setTimeout(()=>window.__TAURI__.window.getCurrentWindow().close(),50);return true;',
      );
    } catch {
      /* cleanup also covers a crashed WebView */
    }

    this.app?.close();
    this.app = undefined;
    await this.stopProcess(this.appProcess);
    this.appProcess = undefined;
  }

  async navigate(path) {
    assert(path.startsWith('/app/'));
    await this.app.evaluate(
      `history.pushState({...history.state},'',${JSON.stringify(path)});dispatchEvent(new PopStateEvent('popstate',{state:history.state}));return true;`,
    );
  }

  async instrument() {
    await this.call(
      'instrument',
      `
      window.__recoveryEvidence={startedAt:Date.now(),network:[],ipc:[],events:[],recoveries:[],imageLoads:[]};
      var ev=window.__recoveryEvidence;
      var originalFetch=window.fetch;
      window.fetch=function(input,init){
        var u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
        var entry={origin:u.origin,path:u.pathname,method:init?.method||input?.method||'GET',at:Date.now()};
        ev.network.push(entry);
        // Tauri's Linux IPC transport uses fetch; record only the command name.
        if(u.protocol==='ipc:'||u.hostname==='ipc.localhost')ev.ipc.push({command:u.pathname.replace(/^\\//,''),at:entry.at});
        var promise=originalFetch.apply(this,arguments);
        promise.then(function(r){entry.status=r.status;entry.doneAt=Date.now()},function(){entry.failed=true});
        return promise;
      };
      var originalRecover=store.recoverMissingFileContents;
      store.recoverMissingFileContents=function(){
        var entry={hash:arguments[0],at:Date.now()};ev.recoveries.push(entry);
        var p=originalRecover.apply(this,arguments);p.then(function(value){entry.value=value;entry.doneAt=Date.now()},function(){entry.failed=true});return p;
      };
      document.addEventListener('load',function(e){if(e.target instanceof HTMLImageElement&&e.target.src.includes('/download/files/'))ev.imageLoads.push({at:Date.now(),width:e.target.naturalWidth,height:e.target.naturalHeight})},true);
      await window.__TAURI__.event.listen('atomic-file-content-stored',function(e){ev.events.push({payload:e.payload,at:Date.now()})});
      return true;
    `,
    );
  }

  async openFile(f) {
    await this.call(
      'open-file',
      `
      store.setDrive(${JSON.stringify(f.drive)});
      var r=await store.getResource(${JSON.stringify(f.file)});window.__fileUnderTest=r;
      window.__fileBefore=JSON.stringify(r.getEntries().sort((a,b)=>a[0].localeCompare(b[0])));
      window.__versionBefore=JSON.stringify([...r.getLoroDoc().oplogVersion().toJSON()].sort());
      window.__pageMarker=${JSON.stringify(randomUUID())};
      history.pushState({...history.state},'', '/app/show?subject='+encodeURIComponent(r.subject));
      dispatchEvent(new PopStateEvent('popstate',{state:history.state}));window.__fileUrl=location.href;return true;
    `,
    );
    this.pageMarker = await this.app.evaluate('return window.__pageMarker;');
  }

  async inspectFile(f) {
    return this.app.evaluate(`var r=window.__fileUnderTest;return {
      url:location.href,clientDb:!!store.clientDb,properties:r.getEntries().length,
      sameResource:r===store.resources.get(${JSON.stringify(f.file)}),
      sameProperties:window.__fileBefore===JSON.stringify(r.getEntries().sort((a,b)=>a[0].localeCompare(b[0]))),
      sameVersion:window.__versionBefore===JSON.stringify([...r.getLoroDoc().oplogVersion().toJSON()].sort()),
      samePage:window.__pageMarker===${JSON.stringify(this.pageMarker)}&&window.__fileUrl===location.href,
      images:[...document.images].filter(e=>e.src.includes(${JSON.stringify(f.hash)})).map(e=>{
        var r=e.getBoundingClientRect(),style=getComputedStyle(e);
        return {width:e.naturalWidth,height:e.naturalHeight,visible:e.getClientRects().length>0&&style.visibility!=='hidden'&&style.display!=='none'&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth};
      }),evidence:window.__recoveryEvidence};`);
  }

  async record(name, data) {
    assert(/^[a-z0-9-]+$/.test(name));
    const path = join(this.artifactDir, `${name}.json`);
    await writeFile(path, JSON.stringify(data, null, 2));
    await chmod(path, 0o644); // Only these explicitly sanitized reports are public.
  }

  async capture(name) {
    assert(/^[a-z0-9-]+$/.test(name));
    const path = join(this.artifactDir, `${name}.png`);
    await this.app.screenshot(path);
    await chmod(path, 0o644);
  }

  async cleanup() {
    const failures = [];

    try {
      await this.stopApp();
    } catch (error) {
      failures.push(error);
    }

    for (const child of [...this.children].reverse()) {
      try {
        await this.stopProcess(child);
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length)
      throw new AggregateError(failures, 'Native test process cleanup failed.');
  }
}
