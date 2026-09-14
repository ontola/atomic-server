import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { pinnedEnvironment, verifyPlaywright } from './toolchain.mjs';

const pin = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url)),
).packageManager;

test('nested pnpm ignores an older PATH executable and installation is noninteractive', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-toolchain-'));

  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: pin }),
    );
    const oldBin = join(root, 'old-bin');
    mkdirSync(oldBin);
    writeFileSync(join(oldBin, 'pnpm'), '#!/bin/sh\nprintf "8.15.0\\n"\n', {
      mode: 0o755,
    });
    const env = pinnedEnvironment(root, root, {
      ...process.env,
      PATH: `${oldBin}${delimiter}${process.env.PATH}`,
    });
    assert.equal(env.CI, 'true');
    const actual = execFileSync('pnpm', ['exec', 'pnpm', '--version'], {
      cwd: root,
      env,
      encoding: 'utf8',
    }).trim();
    assert.equal(`pnpm@${actual}`, pin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an installed Playwright version different from the manifest fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-playwright-'));

  try {
    mkdirSync(join(root, 'e2e/node_modules/@playwright/test'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'e2e/package.json'),
      JSON.stringify({ devDependencies: { '@playwright/test': '1.63.0' } }),
    );
    writeFileSync(
      join(root, 'e2e/node_modules/@playwright/test/package.json'),
      JSON.stringify({ version: '1.60.0' }),
    );
    assert.throws(() => verifyPlaywright(root), /Playwright mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
