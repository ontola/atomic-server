import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sdk = require.resolve('@playwright/test');
const cli = require.resolve('@playwright/test/cli');
const fixtures = fileURLToPath(
  new URL('../tests/fixtures.ts', import.meta.url),
);

// Explicit browser regression, separate from the Node-only unit checks.
test(
  'route teardown drains callbacks and preserves real HTTP errors',
  { timeout: 90_000 },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'atomic-route-lifecycle-'),
    );
    const held = new Map();
    const started = new Set();
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');

      if (url.pathname.startsWith('/slow/')) {
        const key = url.pathname.slice('/slow/'.length);
        started.add(key);
        held.set(key, response);

        return;
      }

      if (url.pathname.startsWith('/release/')) {
        const key = url.pathname.slice('/release/'.length);
        const pending = held.get(key);

        if (key.startsWith('fault-')) pending?.destroy();
        else {
          pending?.writeHead(200, { 'content-type': 'application/json' });
          pending?.end('{"ok":true}');
        }

        held.delete(key);
        response.end('released');

        return;
      }

      if (url.pathname.startsWith('/status/')) {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            started: started.has(url.pathname.slice('/status/'.length)),
          }),
        );

        return;
      }

      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Controlled route lifecycle</title>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    async function run(name, importPath, modes) {
      const folder = path.join(root, name);
      await mkdir(folder);
      const report = path.join(folder, 'report.json');
      await writeFile(
        path.join(folder, 'lifecycle.spec.ts'),
        `
import { test, expect } from ${JSON.stringify(importPath)};
import { writeFileSync } from 'node:fs';
const origin = ${JSON.stringify(origin)};
const output = ${JSON.stringify(folder)};
for (const mode of ${JSON.stringify(modes)}) {
 test(mode, async ({ page, browser }) => {
  const key = ${JSON.stringify(name)} + '-' + mode;
  const target = mode === 'owned' ? await (await browser.newContext()).newPage() : page;
  const owner = mode === 'context' ? target.context() : target;
  let released = false;
  const unrouteAll = owner.unrouteAll.bind(owner);
  owner.unrouteAll = async options => {
   if (!released) { released = true; await fetch(origin + '/release/' + key); }
   return unrouteAll(options);
  };
  await owner.route('**/slow/**', async route => {
   const response = await route.fetch({ maxRetries: 0 });
   await route.fulfill({ response });
   writeFileSync(output + '/' + mode + '.completed', 'completed');
  });
  await target.goto(origin);
  await target.evaluate(key => { void fetch('/slow/' + key).catch(() => {}); }, key);
  await expect.poll(async () => (await (await fetch(origin + '/status/' + key)).json()).started).toBe(true);
  // End while HTTP is held: only the production teardown releases the callback.
 });
}
`,
      );
      await writeFile(
        path.join(folder, 'playwright.config.cjs'),
        `module.exports=${JSON.stringify({ testDir: folder, testMatch: '*.spec.ts', timeout: 8000, workers: 1, retries: 0, reporter: [['json', { outputFile: report }]], use: { browserName: 'chromium', headless: true } })};\n`,
      );
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [cli, 'test', '--config', path.join(folder, 'playwright.config.cjs')],
          {
            detached: true,
            env: { ...process.env, CI: 'true' },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', data => {
            output += data;
          });
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}

          reject(new Error(`${name} timed out: ${output.slice(-2000)}`));
        }, 25_000);
        child.on('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', code => {
          clearTimeout(timer);
          resolve({ code, output });
        });
      });
      assert.ok(
        existsSync(report),
        `${name} did not emit a report: ${result.output}`,
      );

      return {
        ...result,
        report: JSON.parse(await readFile(report, 'utf8')),
        folder,
      };
    }

    try {
      const baseline = await run('baseline', sdk, ['page']);
      assert.notEqual(
        baseline.code,
        0,
        'without the production drain the control must fail',
      );
      assert.match(
        JSON.stringify(baseline.report.errors),
        /route\.fetch.*(?:Test ended|closed)/s,
      );
      const drained = await run('drained', fixtures, [
        'page',
        'context',
        'owned',
      ]);
      assert.equal(
        drained.code,
        0,
        JSON.stringify(drained.report) + drained.output,
      );
      assert.equal(drained.report.stats.expected, 3);
      assert.deepEqual(drained.report.errors, []);
      for (const mode of ['page', 'context', 'owned'])
        assert.equal(
          await readFile(
            path.join(drained.folder, mode + '.completed'),
            'utf8',
          ),
          'completed',
        );
      const fault = await run('fault', fixtures, ['page']);
      assert.notEqual(
        fault.code,
        0,
        'genuine upstream failures must remain red',
      );
      assert.match(
        JSON.stringify(fault.report),
        /route\.fetch|socket hang up|ECONNRESET/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
