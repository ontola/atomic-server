import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

// Run with node --experimental-vm-modules --test. Link only owned fixture
// doubles; evaluate the actual runner unchanged, including its error/finally paths.
const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');

async function run(mode, failAt) {
  const events = [];
  const records = [];
  const writes = [];
  const process = {
    env: mode === undefined ? {} : { NATIVE_RECOVERY_CASE: mode },
    platform: 'linux',
    arch: 'x64',
    exitCode: 0,
  };
  const context = createContext({
    process,
    console: { info() {}, error() {} },
  });
  class RecoveryContext {
    runDir = '/owned/native-fixture';
    stage = 'fixture';
    async init() {
      events.push('init');
      return this;
    }
    async cleanup() {
      events.push('cleanup');
      if (failAt === 'cleanup') throw new Error('private cleanup diagnostic');
    }
    async record(name, data) {
      records.push({ name, data });
    }
  }
  const invoke = name => async () => {
    events.push(name);
    if (failAt === name) throw new Error('private ' + name + ' diagnostic');
    return { realFixtureResult: name };
  };
  const modules = {
    'node:fs/promises': { writeFile: async (...args) => writes.push(args) },
    'node:path': { join },
    '../native-late-file-acceptance.mjs': {
      startControlledPortal: async () => {
        events.push('portal');
        return { close: async () => events.push('portal-close') };
      },
    },
    './support.mjs': { RecoveryContext },
    './storage.mjs': { startStorage: invoke('storage') },
    './peer.mjs': { testPeer: invoke('peer') },
    './vault.mjs': { testVault: invoke('vault') },
  };
  const runner = new SourceTextModule(source, { context });
  await runner.link(specifier => {
    const values = modules[specifier];
    assert.ok(values, `Unexpected runner dependency: ${specifier}`);
    return new SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) {
          this.setExport(key, value);
        }
      },
      { context },
    );
  });
  let error;
  try {
    await runner.evaluate();
  } catch (caught) {
    error = caught;
  }
  return { events, records, writes, process, error };
}

test('default runs both actual case functions and cleans up', async () => {
  const result = await run();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.events, [
    'init', 'portal', 'peer', 'storage', 'vault', 'cleanup', 'portal-close',
  ]);
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.records[0].data.passed, true);
  assert.equal(result.records[0].data.selectedCase, 'both');
});

for (const mode of ['peer', 'vault']) {
  test(`${mode} selection invokes only its owned fixture`, async () => {
    const result = await run(mode);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.events, [
      'init', 'portal', ...(mode === 'peer' ? ['peer'] : ['storage', 'vault']),
      'cleanup', 'portal-close',
    ]);
    assert.equal(result.process.exitCode, 0);
    assert.equal(result.records[0].data.selectedCase, mode);
  });
}

test('invalid selection fails before allocating a context or portal', async () => {
  const result = await run('unknown');
  assert.match(result.error?.message, /NATIVE_RECOVERY_CASE/);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.writes, []);
});

for (const mode of ['peer', 'vault']) {
  test(`${mode} assertion failure exits unsuccessfully and keeps raw diagnostics private`, async () => {
    const result = await run(mode, mode);
    assert.equal(result.error, undefined);
    assert.equal(result.process.exitCode, 1);
    assert.deepEqual(result.events.slice(-2), ['cleanup', 'portal-close']);
    assert.equal(result.records[0].data.passed, false);
    assert.equal(result.records[0].data.selectedCase, mode);
    assert.equal(result.writes[0][0], '/owned/native-fixture/failure.txt');
    assert.match(result.writes[0][1], /private .* diagnostic/);
    assert.equal(JSON.stringify(result.records).includes('diagnostic'), false);
    // Independent CI invocations can still run the other case after failure.
    const other = await run(mode === 'peer' ? 'vault' : 'peer');
    assert.equal(other.process.exitCode, 0);
  });
}

test('cleanup failure prevents a passing result and still closes the portal', async () => {
  const result = await run('peer', 'cleanup');
  assert.equal(result.process.exitCode, 1);
  assert.deepEqual(result.events.slice(-2), ['cleanup', 'portal-close']);
  assert.equal(result.records[0].data.passed, false);
});


async function buildScript(mode) {
  const fixture = await mkdtemp(join(tmpdir(), 'atomic-native-build-mode-'));
  try {
    const repo = join(fixture, 'atomic-server');
    const directory = join(repo, 'desktop/scripts/native-recovery');
    const bin = join(fixture, 'bin');
    const log = join(fixture, 'commands.log');
    await mkdir(directory, { recursive: true });
    await mkdir(join(fixture, 'atomic-saas/portal'), { recursive: true });
    await mkdir(bin);
    await writeFile(join(fixture, 'atomic-saas/Cargo.toml'), '');
    const script = join(directory, 'build-and-test.sh');
    await writeFile(script, await readFile(new URL('./build-and-test.sh', import.meta.url)));
    await writeFile(join(bin, 'uname'), '#!/bin/sh\nprintf "Linux\n"\n');
    await chmod(join(bin, 'uname'), 0o755);
    for (const command of ['pnpm', 'cargo', 'npm', 'dbus-run-session']) {
      const path = join(bin, command);
      await writeFile(path, `#!/bin/sh
printf '%s %s\\n' '${command}' "$*" >> "$MOCK_LOG"
if [ '${command}' = pnpm ]; then
  mkdir -p "$MOCK_REPO/browser/data-browser/dist-tauri"
  printf '<script></script>\\n' > "$MOCK_REPO/browser/data-browser/dist-tauri/index.html"
fi
exit 0
`);
      await chmod(path, 0o755);
    }
    const env = {
      ...globalThis.process.env,
      PATH: bin + ':' + globalThis.process.env.PATH,
      MOCK_LOG: log,
      MOCK_REPO: repo,
      NATIVE_RECOVERY_ARTIFACT_DIR: join(fixture, 'artifacts'),
    };
    if (mode === undefined) delete env.NATIVE_RECOVERY_BUILD_ONLY;
    else env.NATIVE_RECOVERY_BUILD_ONLY = mode;
    let status = 0;
    try {
      execFileSync('bash', [script], { env, stdio: 'pipe' });
    } catch (error) {
      status = error.status;
    }
    const commands = await readFile(log, 'utf8').catch(() => '');
    return { status, commands };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test('build-only builds matching artifacts without running Clippy or recovery', async () => {
  const result = await buildScript('true');
  assert.equal(result.status, 0);
  assert.match(result.commands, /cargo build --locked -p atomic-server-tauri/);
  assert.match(result.commands, /cargo build --locked --bin atomic-saas/);
  assert.doesNotMatch(result.commands, /cargo clippy|dbus-run-session/);
});

test('default build still runs Clippy and the original combined recovery runner', async () => {
  const result = await buildScript();
  assert.equal(result.status, 0);
  assert.match(result.commands, /cargo clippy/);
  assert.match(result.commands, /dbus-run-session .*node desktop\/scripts\/native-recovery\/run.mjs/);
});

test('invalid build-only mode fails before setup or compile commands', async () => {
  const result = await buildScript('maybe');
  assert.equal(result.status, 2);
  assert.equal(result.commands, '');
});
