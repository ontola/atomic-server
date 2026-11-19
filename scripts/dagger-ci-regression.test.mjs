import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  pipeline.rustBuildSlim = () => ({
    sync: async () => calls.push('sdkServerBuild'),
  });
  pipeline.wasmBuild = () => ({ sync: async () => calls.push('sdkWasmBuild') });

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

test('ci prebuilds servers in parallel but serializes SDK and browser interactions after CPU checks', async () => {
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
    'sdkServerBuild',
    'sdkWasmBuild',
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
  pipeline.rustBuildSlim = () => ({ sync: pipeline.sdkServerBuild });
  pipeline.wasmBuild = () => ({ sync: pipeline.sdkWasmBuild });
  pipeline.endToEnd = async () => started.push('endToEnd');
  const result = pipeline.ci('token');
  await turn();
  assert.deepEqual(
    new Set(started),
    new Set(
      [...gates.keys()].filter(
        name => name !== 'rustTest' && name !== 'jsTestIntegration',
      ),
    ),
  );

  gates.get('rustClippy')();
  await turn();
  assert.equal(started.includes('rustTest'), true);
  for (const [name, release] of gates)
    if (!['flutterTest', 'e2eBuild', 'jsTestIntegration'].includes(name))
      release();
  await turn();
  assert.equal(started.includes('endToEnd'), false);

  gates.get('e2eBuild')();
  await turn();
  assert.equal(started.includes('endToEnd'), false);
  assert.equal(started.includes('jsTestIntegration'), false);
  gates.get('flutterTest')();
  await turn();
  assert.equal(started.at(-1), 'jsTestIntegration');
  assert.equal(started.includes('endToEnd'), false);
  gates.get('jsTestIntegration')();
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

test('the fresh Playwright image can read every shared Syncables fixture imported by its spec', () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = (path, excluded = []) => ({
    repositoryPath: resolve(repository, path),
    excluded,
    directory: child => directory(posix.join(path, child)),
    file: child => ({ repositoryPath: resolve(repository, path, child) }),
    withoutDirectory: child => directory(path, [...excluded, child]),
  });
  const pipeline = new AtomicServer(directory('.'));
  // Build output supplies workspace packages, but this image receives source
  // fixtures only through e2eBaseContainer's real directory/file mounts.
  pipeline.jsBuild = () => makeChain('built-browser');
  resetCalls();
  pipeline.e2eBaseContainer();
  const mounts = recordedCalls().filter(
    ([method, , input]) =>
      ['withFile', 'withDirectory'].includes(method) &&
      typeof input?.repositoryPath === 'string',
  );

  const readMountedFile = path => {
    for (const [method, target, input] of [...mounts].reverse()) {
      const relative = posix.relative(target, path);
      if (
        relative === '..' ||
        relative.startsWith('../') ||
        (method === 'withFile' && relative !== '') ||
        input.excluded?.some(
          excluded =>
            relative === excluded || relative.startsWith(excluded + '/'),
        )
      )
        continue;

      return readFileSync(resolve(input.repositoryPath, relative));
    }

    assert.fail(`The Playwright image is missing the imported file ${path}`);
  };

  const specPath = '/app/e2e/tests/syncables-github.spec.ts';
  const ts = createRequire(new URL('../.dagger/package.json', import.meta.url))(
    'typescript',
  );
  const spec = ts.createSourceFile(
    specPath,
    readMountedFile(specPath).toString(),
    ts.ScriptTarget.Latest,
    true,
  );
  const fixturePaths = [];

  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(spec) === 'readFileSync' &&
      ts.isCallExpression(node.arguments[0]) &&
      node.arguments[0].expression.getText(spec) === 'resolvePath'
    ) {
      const [base, ...segments] = node.arguments[0].arguments;
      assert.equal(base.getText(spec), '__dirname');
      assert.ok(segments.every(ts.isStringLiteral));
      fixturePaths.push(
        posix.resolve(
          dirname(specPath),
          ...segments.map(segment => segment.text),
        ),
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(spec);
  assert.ok(fixturePaths.some(path => path.endsWith('.svg')));
  assert.ok(fixturePaths.filter(path => path.endsWith('.json')).length >= 2);

  for (const path of fixturePaths) {
    const expected = resolve(
      repository,
      'browser',
      posix.relative('/app', path),
    );
    assert.deepEqual(readMountedFile(path), readFileSync(expected), path);
  }
});
