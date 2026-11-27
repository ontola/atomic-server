import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,
  readdir,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const browser = join(repo, 'browser');
// CI has the repository-pinned pnpm on PATH. A local worker may explicitly
// select its cached CLI rather than changing the user's global pnpm version.
const cli = process.env.ATOMIC_TEST_PNPM_CLI;
const command = cli ? process.execPath : 'pnpm';
const prefix = cli ? [cli] : [];
const env = {
  ...process.env,
  PATH: dirname(process.execPath) + ':' + process.env.PATH,
};
const pnpm = args =>
  spawnSync(command, [...prefix, ...args], { env, encoding: 'utf8' });

const proof = `import fs from 'node:fs';import path from 'node:path';
const root=path.dirname(process.cwd()),pkg=JSON.parse(fs.readFileSync('package.json')),graph=JSON.parse(fs.readFileSync(path.join(root,'graph.json')));
for(const group of ['dependencies','devDependencies','optionalDependencies'])for(const dep of Object.keys(pkg[group]??{}))if(graph[dep]&&!fs.existsSync(path.join(root,graph[dep],'built')))throw new Error('MISSING_WORKSPACE_ARTIFACT '+dep+' before '+pkg.name);
fs.writeFileSync('built',pkg.name);fs.appendFileSync(path.join(root,'order.log'),pkg.name+'\\n');`;

async function buildFixture(args, addFutureDependency = false) {
  const fixture = await mkdtemp(join(tmpdir(), 'atomic-runtime-closure-'));

  try {
    const root = JSON.parse(await readFile(join(browser, 'package.json')));
    const expected = root.packageManager.split('@')[1].split('+')[0];
    const version = pnpm(['--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(
      version.stdout.trim(),
      expected,
      'graph proof must use the repository-pinned pnpm',
    );
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({
        name: 'runtime-closure-fixture',
        private: true,
        packageManager: root.packageManager,
      }),
    );
    // There are deliberately no compiled files or installed dependencies. Run
    // only the graph's builtin-Node artifact checks, never install/build MAIN.
    await writeFile(
      join(fixture, 'pnpm-workspace.yaml'),
      "packages:\n  - '*'\nverifyDepsBeforeRun: false\n",
    );
    const graph = {};

    for (const directory of await readdir(browser, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      let manifest;

      try {
        manifest = JSON.parse(
          await readFile(join(browser, directory.name, 'package.json')),
        );
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }

      graph[manifest.name] = directory.name;
      await mkdir(join(fixture, directory.name));
      manifest.scripts = { build: 'node ../proof.mjs' };

      if (addFutureDependency && manifest.name === '@tomic/ui') {
        manifest.dependencies['@tomic/future-runtime-helper'] = 'workspace:*';
      }

      await writeFile(
        join(fixture, directory.name, 'package.json'),
        JSON.stringify(manifest),
      );
    }

    if (addFutureDependency) {
      graph['@tomic/future-runtime-helper'] = 'future-runtime-helper';
      await mkdir(join(fixture, 'future-runtime-helper'));
      await writeFile(
        join(fixture, 'future-runtime-helper/package.json'),
        JSON.stringify({
          name: '@tomic/future-runtime-helper',
          version: '1.0.0',
          scripts: { build: 'node ../proof.mjs' },
        }),
      );
    }

    await writeFile(join(fixture, 'graph.json'), JSON.stringify(graph));
    await writeFile(join(fixture, 'proof.mjs'), proof);
    const result = pnpm(['-C', fixture, ...args]);
    const order = (
      await readFile(join(fixture, 'order.log'), 'utf8').catch(() => '')
    )
      .trim()
      .split('\n')
      .filter(Boolean);

    return { ...result, order };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function recipeArguments(relative) {
  const source = (await readFile(join(repo, relative), 'utf8')).replace(
    /\\\n\s*/g,
    ' ',
  );
  const line = source
    .split('\n')
    .find(
      value =>
        value.startsWith('pnpm -C browser ') && value.endsWith(' run build'),
    );
  assert.ok(line, `missing dependency-build recipe in ${relative}`);
  const words = line
    .match(/'[^']*'|"[^"]*"|\S+/g)
    .map(word => word.replace(/^(['"])(.*)\1$/, '$2'));
  assert.deepEqual(words.slice(0, 3), ['pnpm', '-C', 'browser']);

  return words.slice(3);
}

function assertClosure(result, future) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of [
    'utils',
    'lib',
    'ui',
    'table',
    'resource-ui',
    'table-page',
    'form-app',
  ])
    assert.ok(
      result.order.includes('@tomic/' + name),
      `missing runtime package ${name}`,
    );
  assert.ok(
    !result.order.includes('@tomic/data-browser'),
    'the app build follows WASM separately',
  );
  assert.equal(
    new Set(result.order).size,
    result.order.length,
    'each package builds once',
  );
  if (future)
    assert.ok(
      result.order.indexOf('@tomic/future-runtime-helper') <
        result.order.indexOf('@tomic/ui'),
    );
}

test('old seven-package list fails a clean graph on the missing utils artifact', async () => {
  const old = [
    'lib',
    'react',
    'plugin',
    'service-ui',
    'form-renderer',
    'form-app',
    'edit-mode',
  ].flatMap(name => ['--filter', '@tomic/' + name]);
  const result = await buildFixture([
    '--recursive',
    '--workspace-concurrency=1',
    ...old,
    'run',
    'build',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Error: MISSING_WORKSPACE_ARTIFACT @tomic\/utils before @tomic\/lib/,
  );
});

for (const recipe of [
  'scripts/ci-supplemental.py',
  'desktop/scripts/native-recovery/build-and-test.sh',
]) {
  for (const future of [false, true]) {
    test(`${recipe} builds the complete ordered runtime closure (future dependency: ${future})`, async () => {
      const args = await recipeArguments(recipe);
      assert.ok(args.includes('--recursive'));
      assert.ok(
        args.includes('--workspace-concurrency=1'),
        'shared localization writers must be serialized',
      );
      assertClosure(await buildFixture(args, future), future);
    });
  }
}
