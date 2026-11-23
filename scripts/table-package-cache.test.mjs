import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = readFileSync(
  path.join(root, '.github/workflows/table-package.yml'),
  'utf8',
);
const page = workflow.slice(workflow.indexOf('\n  page:\n'));

function step(name) {
  const start = page.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing page step: ${name}`);
  const end = page.indexOf('\n      - ', start + 1);

  return page.slice(start, end < 0 ? undefined : end);
}

function cachePaths(source) {
  const match = source.match(/\n          path: \|\n((?:            .+\n)+)/);
  assert.ok(match, 'Cache paths must remain explicit');

  return match[1].trim().split('\n').map(value => value.trim());
}

const compiledCache = step('Cache isolated formula compilation');
const downloadsCache = step('Cache Cargo downloads');

test('warm formula cache covers the actual private Cargo dirs without skipping a build', () => {
  const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'atomic-table-cache-')));

  try {
    const script = path.join(fixture, 'browser/data-browser/scripts/build-wasm.mjs');
    const wasm = path.join(fixture, 'wasm');
    const bin = path.join(fixture, 'stub-bin');
    const log = path.join(fixture, 'cargo.jsonl');
    mkdirSync(path.dirname(script), { recursive: true });
    mkdirSync(path.join(wasm, 'pkg'), { recursive: true });
    mkdirSync(bin);
    copyFileSync(path.join(root, 'browser/data-browser/scripts/build-wasm.mjs'), script);
    writeFileSync(path.join(wasm, 'pkg/atomic_wasm.js'), 'export const realBuild = true;\n');
    writeFileSync(path.join(wasm, 'pkg/atomic_wasm_bg.wasm'), 'formula fixture');
    const cargo = path.join(bin, 'cargo');
    writeFileSync(cargo, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CACHE_TEST_LOG, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  target: process.env.CARGO_TARGET_DIR, build: process.env.CARGO_BUILD_BUILD_DIR,
}) + '\\n');
`);
    chmodSync(cargo, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      CACHE_TEST_LOG: log,
      CARGO_TARGET_DIR: path.join(fixture, 'wrong-target'),
      CARGO_BUILD_BUILD_DIR: path.join(fixture, 'wrong-build'),
    };
    // Run once cold and again with the directories a successful cache restores.
    execFileSync(process.execPath, [script], { env });
    for (const cached of cachePaths(compiledCache))
      mkdirSync(path.join(fixture, cached), { recursive: true });
    execFileSync(process.execPath, [script], { env });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 4, 'Both cold and warm runs must invoke version and real build');

    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      assert.equal(call.cwd, wasm);
      assert.equal(call.target, path.join(fixture, 'target/wasm-pack'));
      assert.equal(call.build, path.join(call.target, 'build'));
      for (const dir of [call.target, call.build])
        assert.ok(cachePaths(compiledCache).some(cached => {
          const relative = path.relative(path.join(fixture, cached), dir);
          return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        }), `Actual Cargo directory is not cached: ${dir}`);
      assert.deepEqual(call.args, [
        'run', '-q', '--package', 'cargo-bin', '--', 'wasm-pack',
        ...(index % 2 === 0 ? ['--version'] : ['build', '--target', 'web', '--out-dir', 'pkg']),
      ]);
    }
    assert.equal(
      readFileSync(path.join(fixture, 'browser/data-browser/public/wasm/atomic_wasm_bg.wasm'), 'utf8'),
      'formula fixture',
    );
    assert.ok(cachePaths(compiledCache).includes('.bin'), 'Cache the pinned checkout-local wasm-pack installation too');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('compiled artifacts use exact OS/arch and complete Rust-input keys without broad fallback', () => {
  assert.match(compiledCache, /uses: actions\/cache@v4/);
  assert.match(compiledCache, /key: table-page-wasm-v1-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-/);
  assert.doesNotMatch(compiledCache, /restore-keys:|lookup-only:|cache-hit|\n        if:/);
  const inputs = [...compiledCache.matchAll(/'([^']+)'/g)].map(match => match[1]);
  for (const input of [
    'rust-toolchain.toml', 'Cargo.lock', '**/Cargo.toml', '**/.cargo/config*',
    'wasm/**', 'lib/**', 'tools/cargo-bin/**',
    'browser/data-browser/scripts/build-wasm.mjs', '.github/workflows/table-package.yml',
  ]) assert.ok(inputs.includes(input), `Missing compiled-cache invalidation input: ${input}`);
  // lib/** includes its default JSON resources and README include_str! inputs,
  // not merely .rs files. Cargo still validates all inputs on every cache hit.
  assert.match(readFileSync(path.join(root, 'lib/src/populate.rs'), 'utf8'), /include_str!/);
  assert.match(readFileSync(path.join(root, 'lib/src/lib.rs'), 'utf8'), /include_str!/);
});

test('only Cargo downloads have a broad restore prefix and pnpm caches its store after setup', () => {
  assert.deepEqual(cachePaths(downloadsCache), [
    '~/.cargo/registry/index', '~/.cargo/registry/cache', '~/.cargo/registry/src',
    '~/.cargo/git/db', '~/.cargo/git/checkouts',
  ]);
  assert.match(downloadsCache, /hashFiles\('Cargo\.lock'\)/);
  assert.match(downloadsCache, /restore-keys: \|\n            table-page-cargo-downloads-v1-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-/);
  assert.ok(page.indexOf('pnpm/action-setup@v4') < page.indexOf('actions/setup-node@v4'));
  assert.match(page, /cache: pnpm\n          cache-dependency-path: browser\/pnpm-lock\.yaml/);
  assert.doesNotMatch(page, /node_modules\s*$/m);
});

test('cache hits retain every formula, behavior, type and packed-locale validation step', () => {
  const formula = step('Prepare real formula evaluator');
  assert.match(formula, /rustup target add wasm32-unknown-unknown/);
  assert.match(formula, /pnpm --dir browser\/data-browser build:wasm/);
  assert.doesNotMatch(page, /cache-hit|SKIP_WASM_BUILD|continue-on-error|\n        if:/);
  for (const command of [
    'node resource-ui/scripts/check-boundaries.mjs',
    'pnpm --filter @tomic/table-page... build',
    'pnpm --filter @tomic/resource-ui lint',
    'pnpm --filter @tomic/table-page lint',
    'pnpm --filter @tomic/resource-ui typecheck',
    'pnpm --filter @tomic/table-page typecheck',
    'pnpm --filter @tomic/resource-ui test && pnpm --filter @tomic/table-page test',
    'node browser/table-page/scripts/check-package.mjs',
    'node --test scripts/table-package-cache.test.mjs',
  ]) assert.ok(page.includes(command), `Missing validation command: ${command}`);
  for (const dependency of ['table-page', 'resource-ui', 'table', 'ui', 'react', 'lib', 'form-renderer'])
    assert.ok(page.includes(`pnpm --filter @tomic/${dependency} pack --out`));
  assert.ok(page.indexOf('Cache isolated formula compilation') < page.indexOf('Prepare real formula evaluator'));
  for (const file of ['**/.cargo/config*', 'browser/data-browser/scripts/build-wasm.mjs', 'scripts/table-package-cache.test.mjs'])
    assert.equal(workflow.split(`      - '${file}'`).length - 1, 2, `PR and develop path filters must include ${file}`);
});
