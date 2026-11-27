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
    .find((candidate) =>
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
      (error) => error.status === 77,
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
      file: (path) => ({
        contents: async () => (path === '/test-exit-code' ? '0\n' : 'ok'),
      }),
      directory: () => ({}),
    };
  };
  pipeline.netlifyDeploy = async () => 'https://example.test/report';
  pipeline.extractDeployUrl = (output) => output;

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

const staticChecks = ['jsLint', 'jsTypecheck', 'rustFmt'];
const heavyChecks = [
  'docsPublish',
  'typedocPublish',
  'endToEnd',
  'jsTest',
  'jsTestIntegration',
  'flutterTest',
  'rustClippy',
  'rustTest',
];

function stubCi(pipeline) {
  for (const name of [...staticChecks, ...heavyChecks]) {
    pipeline[name] = async () => '';
  }
}

test('build-job limits reject invalid counts before any work', () => {
  for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new AtomicServer(source(), '', limit),
      /max-build-jobs must be an integer >= 0/,
    );
  }
});

test('warm-clone keys rerun only test execs after reusable setup', async () => {
  for (const method of [
    'rustTest',
    'jsTest',
    'jsTestIntegration',
    'flutterTest',
  ]) {
    let defaultCommands;
    for (const key of ['', 'warm-clone-one', 'warm-clone-two']) {
      const pipeline = new AtomicServer(source(), 'stable-seed', 0, 0, key);
      resetCalls();
      await pipeline[method]();
      const calls = recordedCalls();
      const commands = calls
        .filter(([name]) => name === 'withExec')
        .map(([, args]) => args);
      if (!key) defaultCommands = commands;
      else
        assert.deepEqual(
          commands,
          defaultCommands,
          'freshness must not change setup/test commands',
        );
      const markers = calls
        .map((call, index) => ({ call, index }))
        .filter(
          ({ call }) =>
            call[0] === 'withEnvVariable' &&
            call[1] === 'ATOMIC_CI_TEST_RUN_KEY',
        );
      const expected = ['jsTest', 'flutterTest'].includes(method) ? 2 : 1;
      assert.equal(markers.length, key ? expected : 0);
      for (const { call, index } of markers) {
        assert.equal(call[2], key);
        const next = calls[index + 1];
        assert.equal(next[0], 'withExec');
        assert.match(
          next[1].join(' '),
          /cargo nextest run|pnpm run test|node --test|flutter test|cargo test/,
        );
      }
      if (key) {
        const setupCommands = calls
          .slice(0, markers[0].index)
          .filter(([name]) => name === 'withExec');
        assert.ok(
          setupCommands.length > 0,
          'cached setup must precede freshness injection',
        );
      }
    }
  }
});

test('warm-clone keys reject unsafe constructor values', () => {
  for (const key of [
    null,
    true,
    123,
    'two words',
    '../other',
    'x'.repeat(82),
  ]) {
    assert.throws(
      () => new AtomicServer(source(), '', 0, 0, key),
      /test-run-key must be empty or a safe identifier/,
    );
  }
});

test('explicit compile widths override the host profile while the maximum cap still wins', async () => {
  for (const [override, maximum, expected] of [
    [0, 0, 4],
    [64, 0, 64],
    [64, 48, 48],
  ]) {
    const pipeline = new AtomicServer(
      source(),
      'large-runner',
      maximum,
      override,
    );
    resetCalls();
    await pipeline.rustTest(48);
    assert.deepEqual(
      recordedCalls().filter(
        ([name, variable]) =>
          name === 'withEnvVariable' && variable === 'CARGO_BUILD_JOBS',
      ),
      [['withEnvVariable', 'CARGO_BUILD_JOBS', String(expected)]],
    );
    assert.match(nextestCommand(), new RegExp(`--build-jobs ${expected} `));
    assert.match(nextestCommand(), /--test-threads 48 /);
  }
});

test('explicit compile widths reject invalid counts before building', () => {
  for (const count of [-1, 0.5, NaN, Infinity, 129]) {
    assert.throws(
      () => new AtomicServer(source(), '', 0, count),
      /build-jobs must be an integer between 0 and 128/,
    );
  }
});

test('focused Rust tests apply the constructor cap to Cargo and nextest compilation', async () => {
  const pipeline = new AtomicServer(source(), 'test-runner', 1);
  resetCalls();
  await pipeline.rustTest();
  const calls = recordedCalls();
  assert.deepEqual(
    calls.filter(
      ([name, variable]) =>
        name === 'withEnvVariable' && variable === 'CARGO_BUILD_JOBS',
    ),
    [['withEnvVariable', 'CARGO_BUILD_JOBS', '1']],
  );
  const nextest = calls.find(
    ([name, args]) =>
      name === 'withExec' && args[2]?.includes('cargo nextest run'),
  );
  assert.match(nextest?.[1][2], /--build-jobs 1 /);
  assert.match(nextest?.[1][2], /--test-threads 2 /);
  assert.match(nextest?.[1][2], /cargo nextest run --no-fail-fast /);
});

function nextestCommand() {
  const command = recordedCalls().find(
    ([name, args]) =>
      name === 'withExec' && args[2]?.includes('cargo nextest run'),
  );
  assert.ok(command, 'Rust tests must execute cargo nextest');

  return command[1][2];
}

test('Rust test thread defaults retain both host budgets and existing CI calls', async () => {
  for (const [profile, threads] of [
    ['hosted', 2],
    ['mancave', 12],
  ]) {
    const pipeline = new AtomicServer(source());
    stubCi(pipeline);
    const rustArguments = [];
    pipeline.rustTest = async (...args) => rustArguments.push(args);
    await pipeline.ci('token', false, profile);
    assert.deepEqual(rustArguments, [[]]);

    resetCalls();
    await AtomicServer.prototype.rustTest.call(pipeline);
    const implicit = nextestCommand();
    assert.match(implicit, new RegExp(`--test-threads ${threads} `));

    resetCalls();
    await AtomicServer.prototype.rustTest.call(pipeline, 0);
    assert.equal(nextestCommand(), implicit);
  }
});

test('explicit Rust test threads reach nextest without changing compile jobs or coverage', async () => {
  const pipeline = new AtomicServer(source(), 'isolated-rust', 4);
  resetCalls();
  await pipeline.rustTest();
  const defaults = nextestCommand();

  for (const threads of [4, 1, 128]) {
    resetCalls();
    await pipeline.rustTest(threads);
    assert.equal(
      nextestCommand(),
      defaults.replace('--test-threads 2 ', `--test-threads ${threads} `),
    );
    assert.deepEqual(
      recordedCalls().filter(
        ([name, variable]) =>
          name === 'withEnvVariable' && variable === 'CARGO_BUILD_JOBS',
      ),
      [['withEnvVariable', 'CARGO_BUILD_JOBS', '4']],
    );
  }
});

test('Rust test threads reject invalid budgets before constructing any containers', () => {
  const pipeline = new AtomicServer(source());

  for (const threads of [
    -1,
    0.5,
    129,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '4; echo unexpected',
  ]) {
    resetCalls();
    assert.throws(
      () => pipeline.rustTest(threads),
      /test-threads must be an integer between 0 and 128/,
    );
    assert.deepEqual(recordedCalls(), []);
  }
});

test('CI caps both host profiles without raising limits or changing uncapped defaults', async () => {
  for (const [profile, limit, cargo, nextest] of [
    ['hosted', 0, '4', '4'],
    ['hosted', 1, '1', '1'],
    ['hosted', 8, '4', '4'],
    ['mancave', 0, '12', '8'],
    ['mancave', 1, '1', '1'],
    ['mancave', 10, '10', '8'],
  ]) {
    const pipeline = new AtomicServer(source(), '', limit);
    stubCi(pipeline);
    await pipeline.ci('token', false, profile);

    resetCalls();
    await AtomicServer.prototype.rustTest.call(pipeline);
    const rustCalls = recordedCalls();
    assert.deepEqual(
      rustCalls.filter(
        ([name, variable]) =>
          name === 'withEnvVariable' && variable === 'CARGO_BUILD_JOBS',
      ),
      [['withEnvVariable', 'CARGO_BUILD_JOBS', cargo]],
    );
    const command = rustCalls.find(
      ([name, args]) =>
        name === 'withExec' && args[2]?.includes('cargo nextest run'),
    );
    assert.match(command?.[1][2], new RegExp(`--build-jobs ${nextest} `));

    resetCalls();
    await AtomicServer.prototype.flutterTest.call(pipeline);
    assert.deepEqual(
      recordedCalls().filter(
        ([name, variable]) =>
          name === 'withEnvVariable' && variable === 'CARGO_BUILD_JOBS',
      ),
      [['withEnvVariable', 'CARGO_BUILD_JOBS', cargo]],
    );
  }
});

for (const sequential of [false, true]) {
  test(`CI ${sequential ? 'sequential' : 'default parallel'} scheduling retains every check`, async () => {
    const pipeline = new AtomicServer(source());
    const seenStatic = [];
    const starts = [];
    const events = [];
    let active = 0;
    let peak = 0;
    for (const name of staticChecks) {
      pipeline[name] = async () => seenStatic.push(name);
    }
    for (const name of heavyChecks) {
      pipeline[name] = async () => {
        starts.push(name);
        events.push(`start ${name}`);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        events.push(`end ${name}`);
      };
    }

    const args = ['token', false, 'hosted', 'full', 0, 0, -1, false, 'run'];
    // Omitting the final argument also checks that existing callers stay parallel.
    const result = sequential
      ? await pipeline.ci(...args, true)
      : await pipeline.ci(...args);
    assert.equal(result, 'CI pipeline completed successfully');
    assert.deepEqual(seenStatic.sort(), [...staticChecks].sort());
    assert.deepEqual([...starts].sort(), [...heavyChecks].sort());
    assert.equal(active, 0);
    if (sequential) {
      assert.equal(peak, 1);
      assert.deepEqual(starts, [
        'rustTest',
        'rustClippy',
        'jsTest',
        'jsTestIntegration',
        'endToEnd',
        'flutterTest',
        'docsPublish',
        'typedocPublish',
      ]);
    } else {
      assert.equal(peak, 7);
      assert.deepEqual(starts, heavyChecks);
      assert.ok(
        events.indexOf('start rustTest') > events.indexOf('end rustClippy'),
      );
    }
  });
}

test('sequential CI propagates a failed lane before starting the next one', async () => {
  const pipeline = new AtomicServer(source());
  stubCi(pipeline);
  const calls = [];
  for (const name of heavyChecks) {
    pipeline[name] = async () => {
      calls.push(name);
      if (name === 'rustTest') throw new Error('Rust tests failed');
    };
  }
  await assert.rejects(
    () =>
      pipeline.ci('token', false, 'hosted', 'full', 0, 0, -1, false, '', true),
    /Rust tests failed/,
  );
  assert.deepEqual(calls, ['rustTest']);
});

test('HTTP runtime width is opt-in and reaches native service and JS integration', async () => {
  for (const width of [0, 32]) {
    const pipeline = new AtomicServer(source(), '', 0, 0, '', width);
    pipeline.rustBuild = () => makeChain('binary-build');
    pipeline.rustBuildSlim = () => makeChain('slim-binary');
    pipeline.wasmBuild = () => makeChain('wasm');
    for (const run of [
      () => pipeline.atomicService(true, 'width-test'),
      () =>
        pipeline.atomicServiceFromBinary(
          makeChain('verified-binary'),
          true,
          'width-test',
        ),
      () => pipeline.jsTestIntegration(),
    ]) {
      resetCalls();
      await run();
      const overrides = recordedCalls().filter(
        ([name, key]) =>
          name === 'withEnvVariable' && key === 'ATOMIC_HTTP_WORKERS',
      );
      assert.deepEqual(
        overrides,
        width ? [['withEnvVariable', 'ATOMIC_HTTP_WORKERS', '32']] : [],
      );
    }
  }
  for (const width of [-1, 129, 1.5, NaN, Infinity]) {
    resetCalls();
    assert.throws(
      () => new AtomicServer(source(), '', 0, 0, '', width),
      /http-workers/,
    );
    assert.deepEqual(recordedCalls(), []);
  }
});
