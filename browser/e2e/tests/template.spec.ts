import { expect, test } from '@playwright/test';
import { promisify } from 'node:util';
import {
  before,
  makeDrivePublic,
  newDrive,
  signIn,
  sideBarNewResourceTestId,
  FRONTEND_URL,
  inDialog,
} from './test-utils';
import fs from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);
let workspace: string;

async function setupTemplateSite(serverUrl: string, siteType: string) {
  const packages = path.resolve(__dirname, '../..');
  const cwd = path.join(workspace, siteType);
  await run(
    process.execPath,
    [
      path.join(packages, 'create-template/bin/src/index.js'),
      siteType,
      '--template',
      siteType,
      '--server-url',
      serverUrl,
    ],
    { cwd: workspace },
  );

  // Install the same workspace libraries that produced the AtomicServer under test.
  const manifest = path.join(cwd, 'package.json');
  const pkg = JSON.parse(await fs.promises.readFile(manifest, 'utf8'));
  const rootManifest = path.join(packages, 'package.json');
  pkg.packageManager = JSON.parse(
    await fs.promises.readFile(rootManifest, 'utf8'),
  ).packageManager;
  const bindings = siteType === 'nextjs-site' ? 'react' : 'svelte';
  for (const name of ['cli', 'lib', bindings]) {
    const deps = name === 'cli' ? pkg.devDependencies : pkg.dependencies;
    deps['@tomic/' + name] = 'link:' + path.join(packages, name);
  }
  await fs.promises.writeFile(manifest, JSON.stringify(pkg));
  for (const args of [
    ['install', '--no-frozen-lockfile'],
    ['run', 'update-ontologies'],
    ['run', 'build'],
  ]) {
    try {
      await run('pnpm', args, { cwd });
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      throw new Error(`pnpm ${args.join(' ')} failed:\n${stdout}\n${stderr}`);
    }
  }
}

function startServer(siteType: string) {
  const cwd = path.join(workspace, siteType);
  const args =
    siteType === 'nextjs-site'
      ? ['next/dist/bin/next', 'start', '--hostname']
      : ['vite/bin/vite.js', 'preview', '--host'];
  return spawn(
    process.execPath,
    [
      path.join(cwd, 'node_modules', args[0]),
      args[1],
      args[2],
      '127.0.0.1',
      '--port',
      process.env.ATOMIC_E2E_PREVIEW_PORT ?? '0',
    ],
    { cwd, env: { ...process.env, NO_COLOR: '1' } },
  );
}

const waitForServer = (
  childProcess: ChildProcess,
  timeout = 30000,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      childProcess.kill(); // Kill the process if it times out
      reject(new Error('Server took too long to start.'));
    }, timeout);

    childProcess.stdout?.on('data', data => {
      const message = data.toString();

      const match = message.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/);

      if (match) {
        clearTimeout(timeoutId); // Clear the timeout when resolved
        resolve(match[0]); // Resolve with the URL
      }
    });

    childProcess.stderr?.on('data', data => {
      const errorMessage = data.toString();
      console.error(`stderr: ${errorMessage}`);

      if (errorMessage.includes('error')) {
        clearTimeout(timeoutId); // Clear the timeout when rejecting
        reject(new Error(`Server encountered an error: ${errorMessage}`));
      }
    });

    childProcess.on('exit', code => {
      clearTimeout(timeoutId); // Clear the timeout when the process exits

      if (code !== 0) {
        reject(new Error(`Server process exited with code ${code}`));
      }
    });
  });
};

test.describe('Test create-template package', () => {
  test.beforeAll(async () => {
    workspace = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'atomic-template-'),
    );
  });
  test.beforeEach(before);

  test('apply next-js template', async ({ page }) => {
    test.fixme(
      true,
      'Template needs to be updated to Next.js 16 because we require React 19.2.0 or above.',
    );
    test.setTimeout(300_000);
    await signIn(page);
    const drive = await newDrive(page);
    await makeDrivePublic(page);

    // Apply the template in data browser
    await page.getByTestId(sideBarNewResourceTestId).click();
    await expect(page).toHaveURL(`${FRONTEND_URL}/app/new`);

    await page.getByTestId('template-button').click();

    const navigationPromise = page.waitForNavigation();
    await inDialog(page, async (_, closeDialogWith) => {
      await closeDialogWith('Apply template');
    });

    await navigationPromise;

    // Check if the template was applied
    await expect(
      page.getByRole('heading', { name: 'website', level: 1 }),
    ).toBeVisible();

    await setupTemplateSite(drive.driveURL, 'nextjs-site');

    const child = startServer('nextjs-site');
    try {
      const url = await waitForServer(child);

      // check if the server is running
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);

      await expect(page.locator('body')).toContainText(
        'This is a template site generated with @tomic/template.',
      );

      await page.goto(`${url}/blog`);

      // Search for a blogpost
      const searchInput = page.getByRole('searchbox');

      await searchInput.fill('balloon');
      await expect(page.locator('body')).toContainText('Balloon');
      await expect(page.locator('body')).not.toContainText('coffee');
    } finally {
      child.kill();
    }
  });

  test('apply sveltekit template', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    const drive = await newDrive(page);
    await makeDrivePublic(page);

    // Apply the template in data browser
    await page.getByTestId(sideBarNewResourceTestId).click();
    await expect(page).toHaveURL(`${FRONTEND_URL}/app/new`);

    const button = page.getByTestId('template-button');
    await button.click();

    const applyTemplateButton = page.getByRole('button', {
      name: 'Apply template',
    });
    await applyTemplateButton.click();

    await setupTemplateSite(drive.driveURL, 'sveltekit-site');

    const child = startServer('sveltekit-site');
    try {
      //start server
      const url = await waitForServer(child);

      // check if the server is running
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);

      await expect(page.locator('body')).toContainText(
        'This is a template site generated with @tomic/template.',
      );

      await page.goto(`${url}/blog`);

      // Search for a blogpost
      const coffee = page.getByRole('link', {
        name: /Can You Really Survive on Coffee Alone/,
      });
      const balloon = page.getByRole('link', {
        name: /The Biology of Balloon Animals/,
      });
      await expect(coffee).toBeVisible();
      await expect(balloon).toBeVisible();
      await page.getByRole('searchbox').fill('balloon');
      await expect(coffee).toHaveCount(0);
      await expect(balloon).toBeVisible();
    } finally {
      child.kill();
    }
  });

  test.afterAll(async () => {
    if (workspace)
      await fs.promises.rm(workspace, { recursive: true, force: true });
  });
});
