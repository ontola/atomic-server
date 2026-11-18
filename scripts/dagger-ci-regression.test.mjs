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
    'jsTypecheck',
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
  pipeline.rustBuild = (...args) => {
    assert.deepEqual(args, [false, 'x86_64-unknown-linux-musl', true]);

    return { sync: async () => calls.push('e2eBuild') };
  };

  let endToEndArgs;
  pipeline.endToEnd = async (...args) => (endToEndArgs = args);

  await pipeline.ci('token', false, 'hosted', 'light', 3, 4, 0, true, 'run-7');
  assert.deepEqual(endToEndArgs, [
    'token',
    'light',
    3,
    4,
    0,
    '',
    true,
    'run-7',
  ]);

  calls.length = 0;
  await assert.rejects(() =>
    pipeline.ci('token', false, 'hosted', 'full', -1, 0, -1, false),
  );
  assert.deepEqual(calls, []);
});

test('ci builds E2E in parallel but starts browsers only after the other checks finish', async () => {
  const pipeline = new AtomicServer(source());
  const started = [];
  const gates = new Map();
  const turn = () => new Promise(resolve => setImmediate(resolve));
  for (const name of ['jsLint', 'jsTypecheck', 'rustFmt'])
    pipeline[name] = async () => {};
  for (const name of [
    'docsPublish',
    'typedocPublish',
    'jsTest',
    'jsTestIntegration',
    'flutterTest',
    'rustClippy',
    'rustTest',
    'e2eBuild',
  ]) {
    let release;
    const promise = new Promise(resolve => (release = resolve));
    gates.set(name, release);
    pipeline[name] = async () => {
      started.push(name);
      await promise;
    };
  }

  pipeline.rustBuild = () => ({ sync: pipeline.e2eBuild });
  pipeline.endToEnd = async () => started.push('endToEnd');
  const result = pipeline.ci('token');
  await turn();
  assert.deepEqual(
    new Set(started),
    new Set([...gates.keys()].filter(name => name !== 'rustTest')),
  );

  gates.get('rustClippy')();
  await turn();
  assert.equal(started.includes('rustTest'), true);
  for (const [name, release] of gates)
    if (name !== 'flutterTest' && name !== 'e2eBuild') release();
  await turn();
  assert.equal(started.includes('endToEnd'), false);

  gates.get('e2eBuild')();
  await turn();
  assert.equal(started.includes('endToEnd'), false);
  gates.get('flutterTest')();
  assert.equal(await result, 'CI pipeline completed successfully');
  assert.equal(started.at(-1), 'endToEnd');
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
