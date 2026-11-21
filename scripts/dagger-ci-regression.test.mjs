import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { execFileSync } from 'node:child_process';
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

test('Flutter repairs official Ubuntu mirrors in both APT source formats', async () => {
  resetCalls();
  await new AtomicServer(source()).flutterTest();
  const command = recordedCalls()
    .filter(([name]) => name === 'withExec')
    .map(([, args]) => args[2])
    .find(candidate =>
      candidate?.includes('apt-get install -y --no-install-recommends'),
    );
  assert.ok(command);
  assert.match(command, /apt-get update -qq -o APT::Update::Error-Mode=any/);
  const root = mkdtempSync(nodePath.join(tmpdir(), 'atomic-apt-sources-'));

  try {
    mkdirSync(nodePath.join(root, 'sources.list.d'));
    writeFileSync(
      nodePath.join(root, 'sources.list'),
      'deb http://archive.ubuntu.com/ubuntu jammy main\n',
    );
    const deb822 = nodePath.join(root, 'sources.list.d/ubuntu.sources');
    writeFileSync(
      deb822,
      'URIs: http://security.ubuntu.com/ubuntu https://archive.ubuntu.com/ubuntu\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n',
    );
    const other = nodePath.join(root, 'sources.list.d/other.list');
    writeFileSync(other, 'deb https://example.test/packages stable main\n');
    const rewrite = command
      .slice(0, command.indexOf('&& apt-get update'))
      .replace('/etc/apt', '"$APT_TEST_ROOT"');
    execFileSync('sh', ['-c', rewrite], {
      env: { ...process.env, APT_TEST_ROOT: root },
    });
    assert.equal(
      readFileSync(nodePath.join(root, 'sources.list'), 'utf8'),
      'deb https://azure.archive.ubuntu.com/ubuntu jammy main\n',
    );
    assert.equal(
      readFileSync(deb822, 'utf8'),
      'URIs: https://azure.archive.ubuntu.com/ubuntu https://azure.archive.ubuntu.com/ubuntu\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n',
    );
    assert.equal(
      readFileSync(other, 'utf8'),
      'deb https://example.test/packages stable main\n',
    );
    mkdirSync(nodePath.join(root, 'bin'));
    const apt = nodePath.join(root, 'bin/apt-get');
    const log = nodePath.join(root, 'apt.log');
    writeFileSync(
      apt,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$APT_TEST_LOG"\nexit 77\n',
    );
    chmodSync(apt, 0o755);
    assert.throws(
      () =>
        execFileSync(
          'sh',
          ['-c', command.replace('/etc/apt', '"$APT_TEST_ROOT"')],
          {
            env: {
              ...process.env,
              PATH: `${root}/bin:${process.env.PATH}`,
              APT_TEST_ROOT: root,
              APT_TEST_LOG: log,
            },
          },
        ),
      error => error.status === 77,
    );
    assert.equal(
      readFileSync(log, 'utf8'),
      'update -qq -o APT::Update::Error-Mode=any\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('musl builds select headers for their target without changing nested WASI builds', () => {
  for (const target of [
    'x86_64-unknown-linux-musl',
    'aarch64-unknown-linux-musl',
    'armv7-unknown-linux-musleabihf',
  ]) {
    const pipeline = new AtomicServer(source());
    pipeline.jsBuild = () => makeChain('js-build');
    resetCalls();
    pipeline.rustBuild(false, target);
    const bindgenEnv = recordedCalls().filter(
      ([name, variable]) =>
        name === 'withEnvVariable' && variable.startsWith('BINDGEN_'),
    );
    assert.deepEqual(bindgenEnv, [
      [
        'withEnvVariable',
        `BINDGEN_EXTRA_CLANG_ARGS_${target.replaceAll('-', '_')}`,
        `-isystem /usr/local/musl/${target}/include`,
      ],
    ]);
  }
});

test('Rust checks use the same musl headers while glibc and WASM keep their own includes', async () => {
  const pipeline = new AtomicServer(source());
  resetCalls();
  await pipeline.rustClippy();
  assert.deepEqual(
    recordedCalls().filter(
      ([name, variable]) =>
        name === 'withEnvVariable' && variable.startsWith('BINDGEN_'),
    ),
    [
      [
        'withEnvVariable',
        'BINDGEN_EXTRA_CLANG_ARGS_x86_64_unknown_linux_musl',
        '-isystem /usr/local/musl/x86_64-unknown-linux-musl/include',
      ],
    ],
  );

  for (const build of [
    () => pipeline.rustBuildSlim(),
    () => pipeline.wasmBuild(),
  ]) {
    resetCalls();
    build();
    assert.equal(
      recordedCalls().some(
        ([name, variable]) =>
          name === 'withEnvVariable' && variable.startsWith('BINDGEN_'),
      ),
      false,
    );
  }
});
