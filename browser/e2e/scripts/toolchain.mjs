import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';

/** Private Corepack shims also pin nested pnpm calls in package scripts. */
export function pinnedEnvironment(browser, output, inherited = process.env) {
  const { packageManager } = JSON.parse(
    readFileSync(join(browser, 'package.json'), 'utf8'),
  );

  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) {
    throw new Error(`Expected an exact pnpm pin, got ${packageManager}`);
  }

  const bin = join(output, 'toolchain-bin');
  mkdirSync(bin, { recursive: true });
  execFileSync('corepack', ['enable', '--install-directory', bin, 'pnpm'], {
    cwd: browser,
    env: inherited,
    stdio: 'pipe',
  });
  const env = {
    ...inherited,
    CI: 'true',
    PATH: `${bin}${delimiter}${inherited.PATH}`,
  };
  const actual = execFileSync('pnpm', ['--version'], {
    cwd: browser,
    env,
    encoding: 'utf8',
  }).trim();

  if (`pnpm@${actual}` !== packageManager) {
    throw new Error(
      `Package manager mismatch: expected ${packageManager}, got pnpm@${actual}`,
    );
  }

  return env;
}

export function verifyPlaywright(browser) {
  const path = join(browser, 'e2e', 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const expected = manifest.devDependencies['@playwright/test'];
  const require = createRequire(path);
  const actual = require('@playwright/test/package.json').version;

  if (actual !== expected) {
    throw new Error(
      `Playwright mismatch: expected ${expected}, got ${actual}. Run the pinned frozen install.`,
    );
  }

  return actual;
}
