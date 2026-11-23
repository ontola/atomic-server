import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeChain,
  recordedCalls,
  resetCalls,
  setChainResponse,
} from './dagger-test-sdk.mjs';
import {
  BROWSER_SOURCE_FINGERPRINT_SCRIPT,
  validateBundleCommit,
  validateBundleHash,
  validateBrowserManifest,
  validateBrowserShard,
} from '../.dagger/src/browser-bundle.ts';
import { AtomicServer } from '../.dagger/src/index.ts';

const COMMIT = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const EXPECTED = Object.freeze({
  sourceCommit: COMMIT,
  sourceFingerprint: HASH,
  rustVersion: '1.98.1',
  pnpmVersion: '11.10.0',
  playwrightVersion: '1.63.0',
});

function manifest() {
  return {
    version: 1,
    ...EXPECTED,
    platform: 'linux/amd64',
    files: {
      'atomic-server-binary': '1'.repeat(64),
      'client.oci.tar': '2'.repeat(64),
      'test-inventory.json': '3'.repeat(64),
    },
  };
}

test('portable manifest requires the exact checkout, platform and tool versions', () => {
  const valid = manifest();
  assert.equal(validateBrowserManifest(valid, EXPECTED), valid);
  for (const key of Object.keys(EXPECTED)) {
    const wrong = manifest();
    wrong[key] =
      key === 'sourceCommit'
        ? 'c'.repeat(40)
        : key === 'sourceFingerprint'
          ? 'c'.repeat(64)
          : 'other-version';
    assert.throws(
      () => validateBrowserManifest(wrong, EXPECTED),
      new RegExp(`${key} does not match`),
    );
  }
  for (const wrong of [
    null,
    [],
    'manifest',
    {},
    { ...manifest(), version: 2 },
    { ...manifest(), platform: 'linux/arm64' },
    { ...manifest(), files: undefined },
  ])
    assert.throws(() => validateBrowserManifest(wrong, EXPECTED));
  for (const filename of Object.keys(valid.files)) {
    const wrong = manifest();
    delete wrong.files[filename];
    assert.throws(() => validateBrowserManifest(wrong, EXPECTED));
    wrong.files[filename] = '../not-a-hash';
    assert.throws(() => validateBrowserManifest(wrong, EXPECTED));
  }
});

test('commit and manifest references reject abbreviated, mixed-case or shell-like values', () => {
  assert.doesNotThrow(() => validateBundleCommit(COMMIT));
  assert.doesNotThrow(() => validateBundleHash(HASH));
  for (const invalid of [
    '',
    COMMIT.slice(0, 12),
    COMMIT.toUpperCase(),
    `${COMMIT}\n`,
    '$(id)',
  ]) {
    assert.throws(() => validateBundleCommit(invalid));
  }
  for (const invalid of [
    '',
    HASH.slice(0, 40),
    HASH.toUpperCase(),
    `${HASH}\n`,
    '; exit 0',
  ]) {
    assert.throws(() => validateBundleHash(invalid));
  }
});

test('all 35 native shards are accepted and malformed budgets fail closed', () => {
  for (let index = 1; index <= 35; index++) {
    assert.doesNotThrow(() => validateBrowserShard(index, 35, 1, 1));
  }
  assert.doesNotThrow(() => validateBrowserShard(128, 128, 128, 10));
  assert.doesNotThrow(() => validateBrowserShard(1, 1, 1, 0));
  for (const args of [
    [0, 35, 1, 1],
    [36, 35, 1, 1],
    [1, 0, 1, 1],
    [1, 129, 1, 1],
    [1, 35, 0, 1],
    [1, 35, 129, 1],
    [1, 35, 1, -1],
    [1, 35, 1, 11],
    [1.5, 35, 1, 1],
    [1, NaN, 1, 1],
    [1, 35, Infinity, 1],
    [1, 35, 1, 0.5],
  ])
    assert.throws(() => validateBrowserShard(...args), /must be an integer/);
});

function fingerprint(root) {
  return execFileSync(
    process.execPath,
    ['-e', BROWSER_SOURCE_FINGERPRINT_SCRIPT, root],
    {
      encoding: 'utf8',
    },
  );
}

test('source fingerprint survives another checkout and timestamp changes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'atomic-bundle-portable-'));
  try {
    const first = join(temp, 'first');
    const second = join(temp, 'second');
    mkdirSync(join(first, 'empty'), { recursive: true });
    mkdirSync(join(first, 'unicode-🌳'));
    writeFileSync(
      join(first, 'unicode-🌳', 'space name'),
      'text\0with binary\n',
    );
    writeFileSync(join(first, 'executable'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(first, 'executable'), 0o755);
    symlinkSync('unicode-🌳/space name', join(first, 'alias'));
    const original = fingerprint(first);
    assert.match(original, /^[a-f0-9]{64}$/);
    cpSync(first, second, { recursive: true, verbatimSymlinks: true });
    chmodSync(join(second, 'executable'), 0o711);
    // Only executable bits affect a source file's Git semantics.
    assert.equal(fingerprint(second), original);
    utimesSync(join(second, 'unicode-🌳', 'space name'), 1, 1);
    utimesSync(second, 10, 10);
    assert.equal(fingerprint(second), original);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('source fingerprint detects byte, path, executable and symlink-target changes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'atomic-bundle-drift-'));
  try {
    writeFileSync(join(temp, 'entry'), 'first');
    symlinkSync('entry', join(temp, 'alias'));
    const original = fingerprint(temp);
    writeFileSync(join(temp, 'entry'), 'second');
    assert.notEqual(fingerprint(temp), original);
    writeFileSync(join(temp, 'entry'), 'first');
    assert.equal(fingerprint(temp), original);
    chmodSync(join(temp, 'entry'), 0o755);
    assert.notEqual(fingerprint(temp), original);
    chmodSync(join(temp, 'entry'), 0o644);
    assert.equal(fingerprint(temp), original);
    renameSync(join(temp, 'entry'), join(temp, 'renamed'));
    assert.notEqual(fingerprint(temp), original);
    renameSync(join(temp, 'renamed'), join(temp, 'entry'));
    assert.equal(fingerprint(temp), original);
    unlinkSync(join(temp, 'alias'));
    symlinkSync('other', join(temp, 'alias'));
    assert.notEqual(fingerprint(temp), original);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function bundleFixture(changeManifest = () => {}) {
  const files = Object.fromEntries(
    [
      ['atomic-server-binary', 'binary bytes'],
      ['client.oci.tar', 'OCI image bytes'],
      ['test-inventory.json', '{"suites":[]}'],
    ].map(([name, bytes]) => [name, { name, bytes: Buffer.from(bytes) }]),
  );
  const metadata = manifest();
  metadata.files = Object.fromEntries(
    Object.values(files).map(file => [file.name, sha256(file.bytes)]),
  );
  changeManifest(metadata);
  files['manifest.json'] = {
    name: 'manifest.json',
    bytes: Buffer.from(JSON.stringify(metadata)),
  };
  for (const file of Object.values(files)) {
    file.contents = async () => file.bytes.toString('utf8');
  }
  return {
    files,
    manifestHash: sha256(files['manifest.json'].bytes),
    file(name) {
      assert.ok(files[name], `unexpected bundle file: ${name}`);
      return files[name];
    },
  };
}

function importFixtureResponse({
  platform = 'linux/amd64',
  fingerprint = HASH,
} = {}) {
  setChainResponse((_label, property) => {
    if (property === 'platform') return platform;
    if (property !== 'stdout') return undefined;
    const calls = recordedCalls();
    const command = calls.findLast(([name]) => name === 'withExec')?.[1];
    if (command?.[0] === 'sha256sum') {
      assert.deepEqual(command, ['sha256sum', '/artifact']);
      const [, target, file] = calls.findLast(([name]) => name === 'withFile');
      assert.equal(target, '/artifact');
      return `${sha256(file.bytes)}  /artifact\n`;
    }
    if (
      command?.[0] === 'node' &&
      command[2] === BROWSER_SOURCE_FINGERPRINT_SCRIPT
    ) {
      return fingerprint;
    }
    throw new Error(`Unexpected fixture command: ${JSON.stringify(command)}`);
  });
}

function pipelineWithoutBuilds() {
  const pipeline = new AtomicServer(makeChain('checkout'));
  for (const name of [
    'rustBuild',
    'jsBuild',
    'wasmBuild',
    'e2eBaseContainer',
  ]) {
    pipeline[name] = () => {
      throw new Error(`${name} cannot run on an import worker`);
    };
  }
  return pipeline;
}

function assertValidationOnly(expectHashCheck = true) {
  const calls = recordedCalls();
  for (const name of [
    'import_',
    'asTarball',
    'asService',
    'withServiceBinding',
  ]) {
    assert.equal(calls.some(([actual]) => actual === name), false, name);
  }
  const commands = calls
    .filter(([name]) => name === 'withExec')
    .map(([, args]) => args);
  if (expectHashCheck) {
    assert.ok(commands.length > 0, 'cached bytes must actually be checked');
  }
  for (const command of commands) {
    assert.ok(
      command[0] === 'sha256sum' ||
        (command[0] === 'node' &&
          command[2] === BROWSER_SOURCE_FINGERPRINT_SCRIPT),
      `validation must not install, compile or run browsers: ${command[0]}`,
    );
  }
}

test('completed bundles validate after a persistent-volume copy without any build or runtime graph', async () => {
  const bundle = bundleFixture();
  const temp = mkdtempSync(join(tmpdir(), 'atomic-bundle-volume-'));
  try {
    const first = join(temp, 'before-remount');
    const mounted = join(temp, 'remounted');
    mkdirSync(first);
    for (const file of Object.values(bundle.files)) {
      writeFileSync(join(first, file.name), file.bytes);
    }
    cpSync(first, mounted, { recursive: true });
    for (const directory of [first, mounted]) {
      const stored = {
        file(name) {
          const bytes = readFileSync(join(directory, name));
          return { bytes, contents: async () => bytes.toString('utf8') };
        },
      };
      const pipeline = pipelineWithoutBuilds();
      pipeline.e2eShardContainer = () => {
        throw new Error('validation cannot start a browser shard');
      };
      resetCalls();
      importFixtureResponse();
      const receipt = JSON.parse(
        await pipeline.validateBrowserBundle(
          stored,
          COMMIT,
          bundle.manifestHash,
        ),
      );
      assert.ok(Number.isFinite(Date.parse(receipt.validatedAt)));
      assert.deepEqual(receipt, {
        ...JSON.parse(bundle.files['manifest.json'].bytes),
        kind: 'browser-bundle-validation',
        manifestSha256: bundle.manifestHash,
        validatedAt: receipt.validatedAt,
      });
      assertValidationOnly();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('validation-only checks reject incomplete, corrupt and untrusted cache entries', async () => {
  for (const filename of [
    'manifest.json',
    'atomic-server-binary',
    'client.oci.tar',
    'test-inventory.json',
  ]) {
    for (const failure of ['missing', 'corrupt']) {
      const bundle = bundleFixture();
      if (failure === 'missing') delete bundle.files[filename];
      else bundle.files[filename].bytes = Buffer.from('corrupt cached bytes');
      resetCalls();
      importFixtureResponse();
      await assert.rejects(
        () =>
          pipelineWithoutBuilds().validateBrowserBundle(
            bundle,
            COMMIT,
            bundle.manifestHash,
          ),
        failure === 'missing' ? /unexpected bundle file/ : /SHA256 does not match/,
      );
      assertValidationOnly(failure !== 'missing' || filename !== 'manifest.json');
    }
  }
  const bundle = bundleFixture();
  resetCalls();
  importFixtureResponse();
  await assert.rejects(
    () =>
      pipelineWithoutBuilds().validateBrowserBundle(bundle, COMMIT, '0'.repeat(64)),
    /manifest SHA256 does not match/,
  );
  assertValidationOnly();
});

test('cache validation refuses another commit, source, toolchain or architecture before reuse', async () => {
  for (const [key, replacement] of [
    ['sourceCommit', 'c'.repeat(40)],
    ['sourceFingerprint', 'c'.repeat(64)],
    ['rustVersion', '0.0.0'],
    ['pnpmVersion', '0.0.0'],
    ['playwrightVersion', '0.0.0'],
    ['platform', 'linux/arm64'],
  ]) {
    const bundle = bundleFixture(metadata => {
      metadata[key] = replacement;
    });
    resetCalls();
    importFixtureResponse();
    await assert.rejects(
      () =>
        pipelineWithoutBuilds().validateBrowserBundle(
          bundle,
          COMMIT,
          bundle.manifestHash,
        ),
      new RegExp(key),
    );
    assertValidationOnly();
  }
  const bundle = bundleFixture();
  resetCalls();
  importFixtureResponse({ platform: 'linux/arm64' });
  await assert.rejects(
    () =>
      pipelineWithoutBuilds().validateBrowserBundle(
        bundle,
        COMMIT,
        bundle.manifestHash,
      ),
    /linux\/amd64 worker/,
  );
  assert.equal(recordedCalls().some(([name]) => name === 'import_'), false);
});

test('tampered manifest and every corrupted artifact are rejected before executable import', async () => {
  for (const filename of [
    'manifest.json',
    'atomic-server-binary',
    'client.oci.tar',
    'test-inventory.json',
  ]) {
    const bundle = bundleFixture();
    bundle.files[filename].bytes = Buffer.concat([
      bundle.files[filename].bytes,
      Buffer.from('corruption'),
    ]);
    resetCalls();
    importFixtureResponse();
    await assert.rejects(
      () =>
        pipelineWithoutBuilds().browserShard(
          bundle,
          COMMIT,
          bundle.manifestHash,
          1,
          20,
        ),
      /SHA256 does not match/,
    );
    assert.equal(
      recordedCalls().some(([name]) => name === 'import_'),
      false,
      filename,
    );
    assert.equal(
      recordedCalls().some(([name]) => name === 'withServiceBinding'),
      false,
      filename,
    );
  }
});

test('wrong checkout, tools, source input and worker architecture never import the image', async () => {
  for (const options of [
    {
      change: m => {
        m.sourceCommit = 'c'.repeat(40);
      },
      expected: /sourceCommit/,
    },
    {
      change: m => {
        m.sourceFingerprint = 'c'.repeat(64);
      },
      expected: /sourceFingerprint/,
    },
    {
      change: m => {
        m.platform = 'linux/arm64';
      },
      expected: /platform/,
    },
    {
      change: m => {
        m.rustVersion = '0.0.0';
      },
      expected: /rustVersion/,
    },
    {
      change: m => {
        m.pnpmVersion = '0.0.0';
      },
      expected: /pnpmVersion/,
    },
    {
      change: m => {
        m.playwrightVersion = '0.0.0';
      },
      expected: /playwrightVersion/,
    },
    { fingerprint: 'c'.repeat(64), expected: /sourceFingerprint/ },
    { platform: 'linux/arm64', expected: /linux\/amd64 worker/ },
  ]) {
    const bundle = bundleFixture(options.change);
    resetCalls();
    importFixtureResponse(options);
    await assert.rejects(
      () =>
        pipelineWithoutBuilds().browserShard(
          bundle,
          COMMIT,
          bundle.manifestHash,
          1,
          20,
        ),
      options.expected,
    );
    assert.equal(
      recordedCalls().some(([name]) => name === 'import_'),
      false,
    );
  }
});

test('import worker validates before work and runs one unfiltered native shard with its own service', async () => {
  const bundle = bundleFixture();
  for (const [index, count] of [
    [1, 20],
    [20, 20],
    [17, 35],
  ]) {
    const pipeline = pipelineWithoutBuilds();
    resetCalls();
    importFixtureResponse();
    await pipeline.browserShard(
      bundle,
      COMMIT,
      bundle.manifestHash,
      index,
      count,
      1,
      1,
      false,
    );
    const calls = recordedCalls();
    assert.equal(calls.filter(([name]) => name === 'import_').length, 1);
    assert.equal(
      calls.filter(([name]) => name === 'withServiceBinding').length,
      1,
    );
    assert.deepEqual(pipeline.e2eRun, {
      shardCount: count,
      workers: '1',
      retries: '1',
      grep: '',
    });
    const env = Object.fromEntries(
      calls
        .filter(([name]) => name === 'withEnvVariable')
        .map(([, key, value]) => [key, value]),
    );
    assert.equal(env.PLAYWRIGHT_WORKERS, '1');
    assert.equal(env.PLAYWRIGHT_RETRIES, '1');
    assert.equal(env.ATOMIC_E2E_CLONE_SESSION, '0');
    assert.ok(env.E2E_RUN_NONCE);
    assert.equal(env.E2E_SERVICE_INSTANCE, `${env.E2E_RUN_NONCE}-${index}`);
    const browserCommand = calls.find(
      ([name, args]) => name === 'withExec' && args[0] === '/bin/bash',
    )?.[1][2];
    assert.ok(browserCommand);
    assert.match(
      browserCommand,
      new RegExp(`--shard=${index}/${count}(?: |$)`),
    );
    assert.doesNotMatch(browserCommand, /--grep|@smoke/);
    assert.equal(
      calls.findLast(([name]) => name === 'directory')[1],
      '/browser-results',
    );
    const archiveImport = calls.find(([name]) => name === 'import_');
    assert.equal(archiveImport[1], bundle.files['client.oci.tar']);
    assert.ok(
      calls.some(
        ([name, target, file]) =>
          name === 'withFile' &&
          target === '/atomic-server-bin' &&
          file === bundle.files['atomic-server-binary'],
      ),
    );
    const copyCommand = calls.findLast(([name]) => name === 'withExec')[1][2];
    for (const artifact of [
      'test-exit-code',
      'test-output.log',
      'test-results.json',
      'playwright-report',
      'test-results',
    ]) {
      assert.ok(
        copyCommand.includes(artifact),
        `${artifact} must survive a failed browser assertion`,
      );
    }
  }
  resetCalls();
  await assert.rejects(() =>
    pipelineWithoutBuilds().browserShard(
      bundle,
      COMMIT,
      bundle.manifestHash,
      21,
      20,
    ),
  );
  assert.deepEqual(recordedCalls(), []);
});

test('repeated imported invocations get fresh server and browser runtime identities', async () => {
  const bundle = bundleFixture();
  const identities = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    resetCalls();
    importFixtureResponse();
    await pipelineWithoutBuilds().browserShard(
      bundle,
      COMMIT,
      bundle.manifestHash,
      1,
      20,
    );
    identities.push(
      recordedCalls().find(
        ([name, key]) =>
          name === 'withEnvVariable' && key === 'E2E_SERVICE_INSTANCE',
      )[2],
    );
  }
  assert.notEqual(...identities);
});

test('builder exports a service-free client, complete inventory and the optimized E2E binary', async () => {
  const pipeline = new AtomicServer(makeChain('checkout'));
  const built = [];
  pipeline.jsBuild = e2e => {
    built.push(['js', e2e]);
    return makeChain('built-js');
  };
  pipeline.rustBuild = (...args) => {
    built.push(['rust', ...args]);
    return makeChain('built-rust');
  };
  pipeline.browserSourceFingerprint = async () => HASH;
  pipeline.browserArtifactHash = async () => HASH;
  resetCalls();
  await pipeline.prepareBrowserBundle(COMMIT);
  assert.deepEqual(built, [
    ['js', true],
    ['rust', false, 'x86_64-unknown-linux-musl', true],
  ]);
  const calls = recordedCalls();
  assert.equal(calls.filter(([name]) => name === 'asTarball').length, 1);
  assert.equal(
    calls.some(([name]) => name === 'withServiceBinding'),
    false,
  );
  const commands = calls
    .filter(([name]) => name === 'withExec')
    .map(([, args]) => args.join(' '));
  assert.equal(
    commands.filter(command => command.includes('playwright test')).length,
    1,
  );
  assert.ok(
    commands.some(command => command.includes('--list --reporter=json')),
  );
  assert.equal(
    commands.some(command => command.includes('--shard=')),
    false,
  );
  const metadata = JSON.parse(
    calls.find(
      ([name, target]) => name === 'withNewFile' && target === 'manifest.json',
    )[2],
  );
  assert.deepEqual(validateBrowserManifest(metadata, EXPECTED), metadata);
  assert.deepEqual(
    calls
      .filter(([name]) => name === 'withoutMount')
      .map(([, path]) => path)
      .sort(),
    ['/app/.pnpm-store', '/opt/npm-global', '/root/.npm'],
  );
});

test('an actual failed browser shell still exports its exit code, report and trace bytes', async () => {
  const bundle = bundleFixture();
  resetCalls();
  importFixtureResponse();
  await pipelineWithoutBuilds().browserShard(
    bundle,
    COMMIT,
    bundle.manifestHash,
    1,
    20,
  );
  const calls = recordedCalls();
  const browserScript = calls.find(
    ([name, args]) => name === 'withExec' && args[0] === '/bin/bash',
  )[1][2];
  const copyScript = calls.findLast(([name]) => name === 'withExec')[1][2];
  const temp = mkdtempSync(join(tmpdir(), 'atomic-bundle-failed-shell-'));
  try {
    const e2e = join(temp, 'e2e');
    const results = join(temp, 'browser-results');
    mkdirSync(join(temp, 'bin'));
    mkdirSync(e2e);
    const pnpm = join(temp, 'bin', 'pnpm');
    writeFileSync(
      pnpm,
      `#!/bin/sh
mkdir -p "$FAKE_E2E_DIR/playwright-report" "$FAKE_E2E_DIR/test-results/failed"
printf '%s' '{"stats":{"expected":0,"unexpected":1,"flaky":0,"skipped":0},"suites":[]}' > "$PLAYWRIGHT_JSON_OUTPUT_NAME"
printf '%s' 'failure report' > "$FAKE_E2E_DIR/playwright-report/index.html"
printf '%s' 'trace bytes' > "$FAKE_E2E_DIR/test-results/failed/trace.zip"
printf '%s\\n' 'Synthetic failing browser test'
exit 1
`,
    );
    chmodSync(pnpm, 0o755);
    const map = {
      '/app/e2e': e2e,
      '/browser-results': results,
      '/test-exit-code': join(temp, 'test-exit-code'),
      '/test-output.log': join(temp, 'test-output.log'),
      '/test-results.json': join(temp, 'test-results.json'),
    };
    const relocate = script =>
      script.replace(
        /\/app\/e2e|\/browser-results|\/test-exit-code|\/test-output\.log|\/test-results\.json/g,
        original => map[original],
      );
    execFileSync('/bin/bash', ['-c', relocate(browserScript)], {
      cwd: e2e,
      env: {
        ...process.env,
        PATH: `${join(temp, 'bin')}:${process.env.PATH}`,
        FAKE_E2E_DIR: e2e,
        PLAYWRIGHT_WORKERS: '1',
        PLAYWRIGHT_RETRIES: '1',
      },
      encoding: 'utf8',
    });
    execFileSync('sh', ['-c', relocate(copyScript)], { cwd: e2e });
    assert.equal(
      readFileSync(join(results, 'test-exit-code'), 'utf8').trim(),
      '1',
    );
    assert.match(
      readFileSync(join(results, 'test-output.log'), 'utf8'),
      /Synthetic failing browser test/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(results, 'test-results.json'), 'utf8')).stats
        .unexpected,
      1,
    );
    assert.equal(
      readFileSync(join(results, 'playwright-report/index.html'), 'utf8'),
      'failure report',
    );
    assert.equal(
      readFileSync(join(results, 'test-results/failed/trace.zip'), 'utf8'),
      'trace bytes',
    );

    // Configuration errors happen before a JSON/HTML reporter is created.
    // A fresh imported image has no earlier test artifacts to fall back on.
    rmSync(results, { recursive: true });
    rmSync(join(temp, 'test-results.json'));
    rmSync(join(e2e, 'playwright-report'), { recursive: true });
    rmSync(join(e2e, 'test-results'), { recursive: true });
    writeFileSync(
      pnpm,
      '#!/bin/sh\necho "Synthetic config error" >&2\nexit 2\n',
    );
    execFileSync('/bin/bash', ['-c', relocate(browserScript)], {
      cwd: e2e,
      env: {
        ...process.env,
        PATH: `${join(temp, 'bin')}:${process.env.PATH}`,
        PLAYWRIGHT_WORKERS: '1',
        PLAYWRIGHT_RETRIES: '1',
      },
    });
    execFileSync('sh', ['-c', relocate(copyScript)], { cwd: e2e });
    assert.equal(
      readFileSync(join(results, 'test-exit-code'), 'utf8').trim(),
      '2',
    );
    assert.match(
      readFileSync(join(results, 'test-output.log'), 'utf8'),
      /Synthetic config error/,
    );
    assert.equal(existsSync(join(results, 'test-results.json')), false);
    assert.equal(existsSync(join(results, 'playwright-report')), true);
    assert.equal(existsSync(join(results, 'test-results')), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
