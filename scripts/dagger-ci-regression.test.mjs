import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChain, recordedCalls, resetCalls } from './dagger-test-sdk.mjs';

const { AtomicServer } = await import(
  process.env.DAGGER_INDEX ?? '../.dagger/src/index.ts'
);

function source() {
  return {
    directory: () => makeChain('source-directory'),
    file: () => makeChain('source-file'),
  };
}

test('ci validates E2E overrides before work and forwards all budget arguments', async () => {
  const pipeline = new AtomicServer(source());
  const calls = [];
  for (const name of [
    'jsLint',
    'rustFmt',
    'docsPublish',
    'typedocPublish',
    'jsTest',
    'jsTestIntegration',
    'flutterTest',
    'rustClippy',
    'rustTest',
  ])
    pipeline[name] = async () => calls.push(name);

  let endToEndArgs;
  pipeline.endToEnd = async (...args) => (endToEndArgs = args);

  await pipeline.ci('token', false, 'hosted', 'light', 3, 4, 0, true);
  assert.deepEqual(endToEndArgs, ['token', 'light', 3, 4, 0, '', true]);

  calls.length = 0;
  await assert.rejects(() =>
    pipeline.ci('token', false, 'hosted', 'full', -1, 0, -1, false),
  );
  assert.deepEqual(calls, []);
});

test('lint source setup avoids WASM while build setup includes it', async () => {
  const pipeline = new AtomicServer(source());
  pipeline.wasmBuild = () => {
    throw new Error('lint must not build WASM');
  };

  resetCalls();
  await pipeline.jsLint();
  assert.equal(
    recordedCalls().some(
      ([name, path]) =>
        name === 'withDirectory' && path === '/app/data-browser/public/wasm',
    ),
    false,
  );

  pipeline.wasmBuild = () => makeChain('wasm');
  resetCalls();
  pipeline.jsBuild();
  assert.equal(
    recordedCalls().some(
      ([name, path]) =>
        name === 'withDirectory' && path === '/app/data-browser/public/wasm',
    ),
    true,
  );
});

test('end-to-end applies overrides to the actual shard run and clone setting', async () => {
  const pipeline = new AtomicServer(source());
  let cloned;
  const shardIndexes = [];
  pipeline.e2eBaseContainer = () => {
    cloned = pipeline.e2eCloneSessions;
    return {};
  };
  pipeline.e2eShardContainer = (_base, index) => {
    shardIndexes.push(index);
    return {
      file: path => ({
        contents: async () => (path === '/test-exit-code' ? '0\n' : 'ok'),
      }),
      directory: () => ({}),
    };
  };
  pipeline.netlifyDeploy = async () => 'https://example.test/report';
  pipeline.extractDeployUrl = output => output;

  await pipeline.endToEnd('token', 'light', 3, 4, 0, 'focused', true);
  assert.equal(cloned, true);
  assert.deepEqual(shardIndexes, [1]);
  assert.deepEqual(pipeline.e2eRun, {
    shardCount: 1,
    workers: '3',
    retries: '0',
    grep: 'focused',
  });
});

test('JS tests include repository hook registrations', async () => {
  const pipeline = new AtomicServer(source());
  pipeline.wasmBuild = () => makeChain('wasm');
  resetCalls();
  await pipeline.jsTest();
  const mounts = recordedCalls()
    .filter(([name]) => name === 'withFile')
    .map(([, path]) => path);
  assert.ok(mounts.includes('/.codex/hooks.json'));
  assert.ok(mounts.includes('/.claude/settings.json'));
});

test('release and E2E servers embed the integration catalog and bundles', () => {
  for (const e2e of [false, true]) {
    const pipeline = new AtomicServer(source());
    pipeline.jsBuild = () => makeChain('frontend');
    resetCalls();
    pipeline.rustBuild(!e2e, 'x86_64-unknown-linux-musl', e2e);
    const mounts = recordedCalls().filter(
      ([name, path]) => name === 'withDirectory' && path === '/code/integrations',
    );
    assert.equal(mounts.length, 1, 'server must receive the integration assets');
    assert.deepEqual(mounts[0][3].include, ['catalog.json', '*/plugin.js']);
  }
});
