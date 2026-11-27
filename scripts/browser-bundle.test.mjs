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
import { createRequire } from 'node:module';
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
import {
  BROWSER_RETRY_LIST_CHECK_SCRIPT,
  BROWSER_RETRY_LIST_SCRIPT,
  BROWSER_RETRY_RUN_SCRIPT,
  validateBrowserRetryInput,
} from '../.dagger/src/browser-retry.ts';

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
    version: 2,
    sourceFingerprintVersion: 2,
    ...EXPECTED,
    platform: 'linux/amd64',
    files: {
      'atomic-server-binary': '1'.repeat(64),
      'client.oci.tar': '2'.repeat(64),
      'checks.oci.tar': '4'.repeat(64),
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
    { ...manifest(), version: 1 },
    { ...manifest(), sourceFingerprintVersion: undefined },
    { ...manifest(), sourceFingerprintVersion: 1 },
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

test('source fingerprint ignores empty directories left by filtered checkout setup', () => {
  const temp = mkdtempSync(join(tmpdir(), 'atomic-bundle-empty-dirs-'));
  try {
    writeFileSync(join(temp, 'input.ts'), 'export const retained = true;\n');
    const original = fingerprint(temp);
    // Git does not track empty directories. Dependency installation and
    // source filtering can leave these without changing a single input file.
    mkdirSync(join(temp, '.dagger', 'node_modules', '.pnpm'), {
      recursive: true,
    });
    mkdirSync(join(temp, 'browser', 'empty-filtered-parent'), {
      recursive: true,
    });
    assert.equal(fingerprint(temp), original);
    writeFileSync(
      join(temp, 'browser', 'empty-filtered-parent', 'input.ts'),
      'export const additional = true;\n',
    );
    assert.notEqual(fingerprint(temp), original);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('source diagnostics retain the exact file, executable and symlink differences', () => {
  const temp = mkdtempSync(join(tmpdir(), 'atomic-bundle-input-diagnostics-'));
  const inspect = () => JSON.parse(
    execFileSync(
      process.execPath,
      ['-e', BROWSER_SOURCE_FINGERPRINT_SCRIPT, temp, '--manifest'],
      { encoding: 'utf8' },
    ),
  );
  try {
    writeFileSync(join(temp, 'input.ts'), 'first bytes');
    symlinkSync('input.ts', join(temp, 'alias'));
    const first = inspect();
    assert.equal(first.fingerprintVersion, 2);
    assert.equal(first.fingerprint, fingerprint(temp));
    assert.match(first.legacyFingerprint, /^[a-f0-9]{64}$/);
    const entry = (inventory, name) =>
      inventory.files.find(file => file[0] === name);
    assert.deepEqual(entry(first, 'input.ts'), [
      'input.ts', 'file', 0, sha256('first bytes'),
    ]);
    assert.deepEqual(entry(first, 'alias'), ['alias', 'symlink', 'input.ts']);
    mkdirSync(join(temp, 'derived-empty'));
    const empty = inspect();
    assert.equal(empty.fingerprint, first.fingerprint);
    assert.notEqual(empty.legacyFingerprint, first.legacyFingerprint);
    assert.deepEqual(empty.files, first.files);
    assert.ok(empty.directories.includes('derived-empty'));
    writeFileSync(join(temp, 'input.ts'), 'changed bytes');
    const changed = inspect();
    assert.equal(entry(changed, 'input.ts')[3], sha256('changed bytes'));
    assert.deepEqual(entry(changed, 'alias'), entry(first, 'alias'));
    assert.notEqual(changed.fingerprint, first.fingerprint);
    chmodSync(join(temp, 'input.ts'), 0o755);
    const executable = inspect();
    assert.equal(entry(executable, 'input.ts')[2], 0o111);
    unlinkSync(join(temp, 'alias'));
    symlinkSync('new-target', join(temp, 'alias'));
    assert.deepEqual(entry(inspect(), 'alias'), [
      'alias', 'symlink', 'new-target',
    ]);
    writeFileSync(join(temp, 'new-untracked-input.ts'), 'also an input');
    const additional = inspect();
    assert.ok(entry(additional, 'new-untracked-input.ts'));
    assert.notEqual(additional.fingerprint, executable.fingerprint);
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
      ['checks.oci.tar', 'prepared complete Node workspace OCI image bytes'],
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
  checkOutput,
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
    if (checkOutput !== undefined) return checkOutput;
    throw new Error(`Unexpected fixture command: ${JSON.stringify(command)}`);
  });
}

function pipelineWithoutBuilds() {
  const pipeline = new AtomicServer(makeChain('checkout'));
  for (const name of [
    'rustBuild',
    'rustBuildSlim',
    'jsBuild',
    'jsSource',
    'wasmBuild',
    'e2eBaseContainer',
  ]) {
    pipeline[name] = () => {
      throw new Error(`${name} cannot run on an import worker`);
    };
  }
  return pipeline;
}

test('the source-input preflight exports diagnostics without constructing a build', async () => {
  const diagnostics = {
    fingerprintVersion: 2,
    fingerprint: HASH,
    files: [['input.ts', 'file', 0, HASH]],
    directories: [''],
  };
  const pipeline = pipelineWithoutBuilds();
  resetCalls();
  setChainResponse((_label, property) => {
    assert.equal(property, 'stdout');
    const command = recordedCalls().findLast(
      ([name]) => name === 'withExec',
    )[1];
    assert.deepEqual(command, [
      'node', '-e', BROWSER_SOURCE_FINGERPRINT_SCRIPT, '/source', '--manifest',
    ]);
    return JSON.stringify(diagnostics);
  });
  assert.deepEqual(JSON.parse(await pipeline.browserSourceInputs()), diagnostics);
  assertValidationOnly();
});

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
    'checks.oci.tar',
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
    'checks.oci.tar',
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
    ['js', false],
    ['js', true],
    ['rust', false, 'x86_64-unknown-linux-musl', true],
  ]);
  const calls = recordedCalls();
  assert.equal(calls.filter(([name]) => name === 'asTarball').length, 2);
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
    ['/app/.pnpm-store', '/app/.pnpm-store', '/opt/npm-global', '/root/.npm'],
  );
});

test('builder shares one WASM graph while exporting separate complete production checks and E2E images', async () => {
  const pipeline = new AtomicServer(makeChain('checkout'));
  pipeline.rustBuild = () => makeChain('native-binary');
  pipeline.browserSourceFingerprint = async () => HASH;
  pipeline.browserArtifactHash = async () => HASH;
  resetCalls();
  await pipeline.prepareBrowserBundle(COMMIT);
  const calls = recordedCalls();
  assert.equal(
    calls.filter(
      ([name, args]) =>
        name === 'withExec' && args.join(' ').includes('wasm-pack build'),
    ).length,
    1,
  );
  assert.equal(calls.filter(([name]) => name === 'asTarball').length, 2);
  assert.ok(
    calls.some(
      ([name, path]) =>
        name === 'withDirectory' && path === '/atomic-ci/wasm/pkg',
    ),
  );
  assert.ok(
    calls.some(
      ([name, path]) => name === 'withDirectory' && path === '/lib/defaults',
    ),
  );
  const productionArchive = calls.findIndex(([name]) => name === 'asTarball');
  const e2eFlag = calls.findIndex(
    ([name, variable, value]) =>
      name === 'withEnvVariable' && variable === 'VITE_E2E' && value === 'true',
  );
  assert.ok(productionArchive >= 0 && e2eFlag > productionArchive);
  assert.equal(
    calls.some(([name]) => name === 'withServiceBinding'),
    false,
  );
  assert.equal(pipeline.bundleWasm, undefined);
  const metadata = JSON.parse(
    calls.find(
      ([name, path]) => name === 'withNewFile' && path === 'manifest.json',
    )[2],
  );
  assert.equal(metadata.version, 2);
  assert.ok(metadata.files['checks.oci.tar']);
});

test('verified imported workspaces execute every unit, type and TypeDoc check without rebuilding or installing', async () => {
  const expected = {
    'js-test': [
      ['pnpm', 'run', 'test'],
      ['node', '--test', 'data-browser/scripts/integration-mcp.test.mjs'],
    ],
    'js-typecheck': [
      [
        'pnpm',
        '--filter=!@tomic/data-browser',
        'run',
        '-r',
        '--parallel',
        'typecheck',
      ],
      [
        'pnpm',
        '--filter',
        '@tomic/data-browser',
        'exec',
        'tsc',
        '--noEmit',
        '-p',
        '/browser/data-browser/tsconfig.json',
      ],
    ],
    'typedoc-publish': [['pnpm', 'run', 'typedoc-publish']],
  };
  for (const [checkName, commands] of Object.entries(expected)) {
    const nonces = [];
    for (let invocation = 0; invocation < 2; invocation++) {
      const bundle = bundleFixture();
      resetCalls();
      importFixtureResponse({ checkOutput: 'checks executed' });
      assert.equal(
        await pipelineWithoutBuilds().bundleCheck(
          bundle,
          COMMIT,
          bundle.manifestHash,
          checkName,
          'token',
        ),
        'checks executed',
      );
      const calls = recordedCalls();
      const imported = calls.findIndex(([name]) => name === 'import_');
      assert.equal(calls[imported][1], bundle.files['checks.oci.tar']);
      const runtime = calls.slice(imported);
      assert.deepEqual(
        runtime.filter(([name]) => name === 'withExec').map(([, args]) => args),
        commands,
      );
      assert.equal(
        calls.some(([name]) => name === 'withServiceBinding'),
        false,
      );
      assert.equal(
        runtime.some(
          ([name, variable]) =>
            name === 'withEnvVariable' && variable === 'VITE_E2E',
        ),
        false,
      );
      const nonce = runtime.findIndex(
        ([name, variable]) =>
          name === 'withEnvVariable' &&
          variable === 'ATOMIC_BUNDLE_CHECK_NONCE',
      );
      assert.ok(
        nonce >= 0 &&
          nonce < runtime.findIndex(([name]) => name === 'withExec'),
      );
      nonces.push(runtime[nonce][2]);
      if (checkName === 'js-typecheck') {
        assert.ok(
          runtime.some(
            ([name, variable, value]) =>
              name === 'withEnvVariable' &&
              variable === 'NODE_OPTIONS' &&
              value === '--max-old-space-size=4096',
          ),
        );
      }
      if (checkName === 'typedoc-publish') {
        assert.ok(
          runtime.some(
            ([name, variable, value]) =>
              name === 'withSecretVariable' &&
              variable === 'NETLIFY_AUTH_TOKEN' &&
              value === 'token',
          ),
        );
        assert.ok(
          runtime.some(
            ([name, variable, value]) =>
              name === 'withEnvVariable' &&
              variable === 'NETLIFY_PROD' &&
              value === '',
          ),
        );
      }
    }
    assert.notEqual(...nonces);
  }
});

test('prepared integration checks share only WASM and retain their separate native server and original fixture paths', async () => {
  const bundle = bundleFixture();
  const pipeline = pipelineWithoutBuilds();
  const binary = { name: 'native-debug-glibc' };
  let nativeBuilds = 0;
  pipeline.rustBuildSlim = () => {
    nativeBuilds++;
    return binary;
  };
  resetCalls();
  importFixtureResponse({ checkOutput: 'integration executed' });
  assert.equal(
    await pipeline.bundleCheck(
      bundle,
      COMMIT,
      bundle.manifestHash,
      'js-test-integration',
      'token',
    ),
    'integration executed',
  );
  assert.equal(nativeBuilds, 1);
  const calls = recordedCalls();
  assert.ok(
    calls.some(
      ([name, path]) => name === 'directory' && path === '/atomic-ci/wasm/pkg',
    ),
  );
  assert.ok(
    calls.some(
      ([name, path]) => name === 'withDirectory' && path === '/repo/wasm/pkg',
    ),
  );
  assert.ok(
    calls.some(
      ([name, path, file]) =>
        name === 'withFile' &&
        path === '/repo/target/debug/atomic-server' &&
        file === binary,
    ),
  );
  assert.ok(
    calls.some(
      ([name, path]) => name === 'withWorkdir' && path === '/repo/browser/lib',
    ),
  );
  assert.equal(
    calls.some(
      ([name, args]) =>
        name === 'withExec' && args.join(' ').includes('wasm-pack'),
    ),
    false,
  );
  assert.deepEqual(calls.findLast(([name]) => name === 'withExec')[1], [
    'pnpm',
    'run',
    'test:integration',
  ]);
  const nonce = calls.findLastIndex(
    ([name, variable]) =>
      name === 'withEnvVariable' && variable === 'ATOMIC_BUNDLE_CHECK_NONCE',
  );
  assert.equal(calls[nonce + 1][0], 'withExec');
});

test('prepared checks reject unsupported names and corrupt/incomplete workspace payloads before importing any image', async () => {
  for (const name of ['', 'rust-test', 'js-test; echo unsafe']) {
    resetCalls();
    await assert.rejects(
      () =>
        pipelineWithoutBuilds().bundleCheck(
          bundleFixture(),
          COMMIT,
          HASH,
          name,
          'token',
        ),
      /Unsupported/,
    );
    assert.deepEqual(recordedCalls(), []);
  }
  for (const mode of ['missing', 'corrupt']) {
    const bundle = bundleFixture();
    if (mode === 'missing') delete bundle.files['checks.oci.tar'];
    else
      bundle.files['checks.oci.tar'].bytes = Buffer.from('corrupt workspace');
    resetCalls();
    importFixtureResponse();
    await assert.rejects(() =>
      pipelineWithoutBuilds().bundleCheck(
        bundle,
        COMMIT,
        bundle.manifestHash,
        'js-test',
        'token',
      ),
    );
    assert.equal(
      recordedCalls().some(([name]) => name === 'import_'),
      false,
    );
  }
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
printf '%s' '{"status":"failed","failedTests":["failed-id"]}' > "$FAKE_E2E_DIR/test-results/.last-run.json"
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
      '/retry-last-run.json': join(temp, 'retry-last-run.json'),
    };
    const relocate = script =>
      script.replace(
        /\/app\/e2e|\/browser-results|\/test-exit-code|\/test-output\.log|\/test-results\.json|\/retry-last-run\.json/g,
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
    const receipt = JSON.parse(readFileSync(join(results, 'browser-run.json'), 'utf8'));
    assert.equal(receipt.sourceCommit, COMMIT);
    assert.equal(receipt.manifestSha256, bundle.manifestHash);
    assert.equal(receipt.reportSha256, sha256(readFileSync(join(results, 'test-results.json'))));
    assert.equal(receipt.lastRunSha256, sha256(readFileSync(join(results, 'test-results/.last-run.json'))));
    const originalLastRun = readFileSync(join(e2e, 'test-results/.last-run.json'));
    // --last-failed-file writes its updated result at the explicit path,
    // outside Playwright's output directory. Export that updated file too.
    writeFileSync(map['/retry-last-run.json'], '{"status":"passed","failedTests":[]}');
    execFileSync('sh', ['-c', relocate(copyScript)], { cwd: e2e });
    assert.deepEqual(readFileSync(join(results, 'test-results/.last-run.json')), readFileSync(map['/retry-last-run.json']));
    assert.deepEqual(readFileSync(join(e2e, 'test-results/.last-run.json')), originalLastRun);
    assert.equal(JSON.parse(readFileSync(join(results, 'browser-run.json'), 'utf8')).lastRunSha256,
      sha256(readFileSync(map['/retry-last-run.json'])));
    rmSync(map['/retry-last-run.json']);

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

function retryFixture(change = () => {}) {
  const spec = (id, status, expectedStatus, result) => ({
    id,
    title: id,
    file: 'tests/retry.spec.ts',
    line: 1,
    column: 1,
    tests: [
      {
        projectName: 'chromium',
        status,
        expectedStatus,
        results: result ? [{ status: result, retry: 0 }] : [],
      },
    ],
  });
  const report = {
    config: {
      shard: { current: 1, total: 3 },
      projects: [{ name: 'chromium', retries: 0 }],
    },
    errors: [],
    suites: [
      {
        title: 'tests/retry.spec.ts',
        specs: [
          spec('failed-id', 'unexpected', 'passed', 'failed'),
          spec('passed-id', 'expected', 'passed', 'passed'),
          spec('blocked-id', 'skipped', 'passed'),
          spec('skipped-id', 'skipped', 'skipped', 'skipped'),
        ],
      },
    ],
  };
  const lastRun = {
    status: 'failed',
    failedTests: ['failed-id', 'blocked-id'],
  };
  change(report, lastRun);
  const bundle = bundleFixture();
  bundle.files['test-inventory.json'].bytes = Buffer.from(
    JSON.stringify(report),
  );
  const metadata = JSON.parse(bundle.files['manifest.json'].bytes);
  metadata.files['test-inventory.json'] = sha256(
    bundle.files['test-inventory.json'].bytes,
  );
  bundle.files['manifest.json'].bytes = Buffer.from(JSON.stringify(metadata));
  bundle.manifestHash = sha256(bundle.files['manifest.json'].bytes);
  const texts = {
    'test-results.json': JSON.stringify(report),
    'test-results/.last-run.json': JSON.stringify(lastRun),
    'test-exit-code': '1\n',
  };
  const receipt = {
    version: 1,
    kind: 'browser-first-pass',
    sourceCommit: COMMIT,
    manifestSha256: bundle.manifestHash,
    shardIndex: 1,
    shardCount: 3,
    playwrightRetries: 0,
    reportSha256: sha256(texts['test-results.json']),
    lastRunSha256: sha256(texts['test-results/.last-run.json']),
    exitCodeSha256: sha256(texts['test-exit-code']),
  };
  texts['browser-run.json'] = JSON.stringify(receipt);
  const firstRun = {
    file(name) {
      assert.ok(Object.hasOwn(texts, name), `missing first-run ${name}`);
      return {
        bytes: Buffer.from(texts[name]),
        contents: async () => texts[name],
      };
    },
  };
  const input = () => ({
    report,
    inventory: report,
    lastRun,
    receipt: JSON.parse(texts['browser-run.json']),
    exitCode: texts['test-exit-code'],
    sourceCommit: COMMIT,
    manifestSha256: bundle.manifestHash,
    shardIndex: 1,
    shardCount: 3,
    reportSha256: sha256(texts['test-results.json']),
    lastRunSha256: sha256(texts['test-results/.last-run.json']),
    exitCodeSha256: sha256(texts['test-exit-code']),
  });
  return { report, lastRun, bundle, firstRun, texts, receipt, input };
}

test('deferred retries narrow native last-run IDs to actual completed failures', () => {
  const fixture = retryFixture();
  const before = JSON.stringify(fixture);
  const selection = validateBrowserRetryInput(fixture.input());
  assert.deepEqual(selection.failedTestIds, ['failed-id']);
  assert.deepEqual(selection.excludedLastRunTestIds, ['blocked-id']);
  assert.equal(selection.firstReportSha256, fixture.receipt.reportSha256);
  assert.equal(
    JSON.stringify(fixture),
    before,
    'original failure evidence is immutable',
  );
});

test('malformed, broadened and non-failure retry inputs fail before an image/service is imported', async () => {
  const cases = [
    fixture => {
      delete fixture.texts['test-results/.last-run.json'];
    },
    fixture => {
      fixture.texts['test-results/.last-run.json'] = '{';
    },
    fixture => {
      delete fixture.texts['browser-run.json'];
    },
    fixture => {
      fixture.texts['browser-run.json'] = JSON.stringify({
        ...fixture.receipt,
        sourceCommit: 'c'.repeat(40),
      });
    },
    fixture => {
      fixture.texts['browser-run.json'] = JSON.stringify({
        ...fixture.receipt,
        reportSha256: 'c'.repeat(64),
      });
    },
    fixture => {
      fixture.texts['browser-run.json'] = JSON.stringify({
        ...fixture.receipt,
        lastRunSha256: 'c'.repeat(64),
      });
    },
  ];
  for (const mutate of cases) {
    const fixture = retryFixture();
    mutate(fixture);
    const pipeline = pipelineWithoutBuilds();
    pipeline.browserSourceFingerprint = async () => HASH;
    pipeline.browserArtifactHash = async file => sha256(file.bytes);
    resetCalls();
    await assert.rejects(() =>
      pipeline.browserRetry(
        fixture.bundle,
        COMMIT,
        fixture.bundle.manifestHash,
        fixture.firstRun,
        1,
        3,
        4,
      ),
    );
    assert.equal(
      recordedCalls().some(([name]) => name === 'import_'),
      false,
    );
    assert.equal(
      recordedCalls().some(([name]) => name === 'withServiceBinding'),
      false,
    );
  }
  const invalidReports = [
    report => {
      report.errors.push({ message: 'global failure' });
    },
    report => {
      report.config.shard.current = 2;
    },
    report => {
      report.config.projects[0].retries = 1;
    },
    report => {
      report.config.projects.push({ name: 'other', retries: 0 });
    },
    report => {
      report.suites[0].specs[0].tests[0].results[0].status = 'interrupted';
    },
    report => {
      report.suites[0].specs[0].tests[0].expectedStatus = 'failed';
    },
    report => {
      report.suites[0].specs[0].tests[0].results[0].retry = 1;
    },
    (_report, lastRun) => {
      lastRun.failedTests.push('passed-id');
    },
    (_report, lastRun) => {
      lastRun.failedTests.pop();
    },
    (_report, lastRun) => {
      lastRun.failedTests.push('failed-id');
    },
  ];
  for (const mutate of invalidReports) {
    const fixture = retryFixture(mutate);
    assert.throws(() => validateBrowserRetryInput(fixture.input()));
  }
});

test('retry graph imports the same bundle, verifies selection before service start and runs no shard/immediate retry', async () => {
  const fixture = retryFixture();
  const pipeline = pipelineWithoutBuilds();
  pipeline.browserSourceFingerprint = async () => HASH;
  pipeline.browserArtifactHash = async file => sha256(file.bytes);
  resetCalls();
  await pipeline.browserRetry(
    fixture.bundle,
    COMMIT,
    fixture.bundle.manifestHash,
    fixture.firstRun,
    1,
    3,
    8,
  );
  const calls = recordedCalls();
  assert.equal(calls.filter(([name]) => name === 'import_').length, 1);
  const selected = JSON.parse(
    calls.find(
      ([name, path]) =>
        name === 'withNewFile' && path === '/retry-last-run.json',
    )[2],
  );
  assert.deepEqual(selected.failedTests, ['failed-id']);
  const listIndex = calls.findIndex(
    ([name, args]) =>
      name === 'withExec' && args[2] === BROWSER_RETRY_LIST_CHECK_SCRIPT,
  );
  const serviceIndex = calls.findIndex(
    ([name]) => name === 'withServiceBinding',
  );
  assert.ok(listIndex >= 0 && listIndex < serviceIndex);
  const scripts = calls
    .filter(([name, args]) => name === 'withExec' && args[0] === '/bin/bash')
    .map(([, args]) => args[2]);
  assert.ok(scripts.includes(BROWSER_RETRY_LIST_SCRIPT));
  assert.ok(scripts.includes(BROWSER_RETRY_RUN_SCRIPT));
  for (const script of scripts) {
    assert.match(script, /--last-failed/);
    assert.match(script, /--retries=0/);
    assert.match(script, /--no-deps/);
    assert.doesNotMatch(script, /--shard/);
    assert.doesNotMatch(script, /install|cargo|build/);
  }
  assert.ok(
    calls.some(
      ([name, variable, value]) =>
        name === 'withEnvVariable' &&
        variable === 'PLAYWRIGHT_RETRIES' &&
        value === '0',
    ),
  );
  assert.ok(
    calls.some(
      ([name, variable]) =>
        name === 'withEnvVariable' && variable === 'E2E_RUN_NONCE',
    ),
  );
  const receipt = JSON.parse(
    calls.findLast(
      ([name, path]) =>
        name === 'withNewFile' && path === 'retry-selection.json',
    )[2],
  );
  assert.deepEqual(receipt.failedTestIds, ['failed-id']);
});

test('pinned Playwright actually lists and retries only failed IDs while original evidence stays intact', () => {
  // Source preflight installs only the Dagger module, not the browser workspace.
  // Own this fixture's CLI here, while checking it matches the real E2E pin.
  const require = createRequire(
    new URL('../.dagger/package.json', import.meta.url),
  );
  const cli = require.resolve('@playwright/test/cli');
  const library = require.resolve('@playwright/test');
  const browserPackage = JSON.parse(
    readFileSync(
      new URL('../browser/e2e/package.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(
    require('@playwright/test/package.json').version,
    browserPackage.devDependencies['@playwright/test'],
  );
  const temp = mkdtempSync(join(tmpdir(), 'atomic-deferred-retry-'));
  try {
    const report = join(temp, 'first-report.json');
    const retriedReport = join(temp, 'retry-report.json');
    const lastRun = join(temp, 'original-last-run.json');
    const narrowed = join(temp, 'selected-last-run.json');
    const list = join(temp, 'retry-test-list.json');
    const calls = join(temp, 'calls.txt');
    const ready = join(temp, 'ready');
    const config = join(temp, 'playwright.config.cjs');
    writeFileSync(
      config,
      `module.exports = ${JSON.stringify({
        testDir: temp,
        outputDir: join(temp, 'artifacts'),
        retries: 0,
        workers: 1,
        projects: [{ name: 'chromium' }],
        reporter: [['json']],
        timeout: 2000,
      })};\n`,
    );
    writeFileSync(
      join(temp, 'retry.spec.cjs'),
      `
const { test, expect } = require(${JSON.stringify(library)});
const fs = require('node:fs');
test('passing test with › separator', () => fs.appendFileSync(${JSON.stringify(calls)}, 'passed\\n'));
test('failed until next round', () => {
  fs.appendFileSync(${JSON.stringify(calls)}, 'failed\\n');
  expect(fs.existsSync(${JSON.stringify(ready)})).toBe(true);
});
test('unrelated passing test', () => fs.appendFileSync(${JSON.stringify(calls)}, 'other\\n'));
test.skip('existing skip', () => {});
`,
    );
    const run = (args, output) =>
      execFileSync(process.execPath, [cli, 'test', '-c', config, ...args], {
        cwd: temp,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: output },
        stdio: 'pipe',
      });
    assert.throws(
      () => run(['--shard=1/1', '--last-failed-file', lastRun], report),
      error => error.status === 1,
    );
    const originalReport = readFileSync(report, 'utf8');
    const originalLastRun = readFileSync(lastRun, 'utf8');
    const failures = JSON.parse(originalLastRun).failedTests;
    assert.equal(failures.length, 1);
    const identity = {
      version: 1,
      kind: 'browser-first-pass',
      sourceCommit: COMMIT,
      manifestSha256: HASH,
      shardIndex: 1,
      shardCount: 1,
      playwrightRetries: 0,
      reportSha256: sha256(originalReport),
      lastRunSha256: sha256(originalLastRun),
      exitCodeSha256: sha256('1\n'),
    };
    const selection = validateBrowserRetryInput({
      report: JSON.parse(originalReport),
      inventory: JSON.parse(originalReport),
      lastRun: JSON.parse(originalLastRun),
      receipt: identity,
      exitCode: '1\n',
      sourceCommit: COMMIT,
      manifestSha256: HASH,
      shardIndex: 1,
      shardCount: 1,
      reportSha256: identity.reportSha256,
      lastRunSha256: identity.lastRunSha256,
      exitCodeSha256: identity.exitCodeSha256,
    });
    assert.deepEqual(selection.failedTestIds, failures);
    writeFileSync(
      narrowed,
      JSON.stringify({ status: 'failed', failedTests: failures }),
    );
    const flags = [
      '--retries=0',
      '--no-deps',
      '--last-failed',
      '--last-failed-file',
      narrowed,
    ];
    run([...flags, '--list', '--reporter=json'], list);
    execFileSync(process.execPath, [
      '-e',
      BROWSER_RETRY_LIST_CHECK_SCRIPT.replaceAll(
        '/retry-last-run.json',
        narrowed,
      ).replaceAll('/retry-test-list.json', list),
    ]);
    // A broadened native list is rejected before executing any test body.
    const broad = JSON.parse(readFileSync(list, 'utf8'));
    broad.suites[0].specs.push({
      ...broad.suites[0].specs[0],
      id: 'unexpected-other-id',
    });
    writeFileSync(list, JSON.stringify(broad));
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          '-e',
          BROWSER_RETRY_LIST_CHECK_SCRIPT.replaceAll(
            '/retry-last-run.json',
            narrowed,
          ).replaceAll('/retry-test-list.json', list),
        ],
        { stdio: 'pipe' },
      ),
    );
    writeFileSync(ready, 'ready');
    run(flags, retriedReport);
    const retried = JSON.parse(readFileSync(retriedReport, 'utf8'));
    assert.equal(retried.config.shard, null);
    assert.deepEqual(retried.stats.expected, 1);
    assert.equal(retried.stats.unexpected, 0);
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
      'passed',
      'failed',
      'other',
      'failed',
    ]);
    assert.equal(readFileSync(report, 'utf8'), originalReport);
    assert.equal(readFileSync(lastRun, 'utf8'), originalLastRun);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
