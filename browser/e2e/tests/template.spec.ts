import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { exec } from 'child_process';
import {
  before,
  makeDrivePublic,
  newDrive,
  signIn,
  sideBarNewResourceTestId,
  FRONTEND_URL,
} from './test-utils';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import kill from 'kill-port';
import { log } from 'node:console';
import os from 'node:os';

const EXEC_DIR = path.join(os.tmpdir(), 'atomic-data-template-tests');

const pathToPackage = (
  libName: 'lib' | 'cli' | 'react' | 'svelte' | 'create-template',
) => {
  return path.join(__dirname, '..', '..', libName);
};

const execAsync = async (command: Parameters<typeof exec>[0], cwd?: string) => {
  return new Promise((resolve, reject) => {
    const options = {
      cwd: cwd ? path.join(EXEC_DIR, cwd) : EXEC_DIR,
    };

    exec(command, options, (err, stdout, stderr) => {
      // eslint-disable-next-line no-console
      console.log(stdout, stderr);

      if (err) {
        // eslint-disable-next-line no-console
        console.log(
          `Encountered error while excecuting ${command} in ${options.cwd}`,
        );
        reject(new Error(err.message));
      }

      if (stderr) {
        reject(new Error(stderr.toString()));
      }

      resolve(stdout.toString());
    });
  });
};

// test.describe.configure({ mode: 'serial' });

async function setupTemplateSite(serverUrl: string, siteType: string) {
  if (!fs.existsSync(EXEC_DIR)) {
    fs.mkdirSync(EXEC_DIR);
    await execAsync('pnpm init');
    await execAsync(`pnpm link ${pathToPackage('create-template')}`);
  }

  await execAsync(
    `pnpm exec create-template ${siteType} --template ${siteType} --server-url ${serverUrl}`,
  );

  await execAsync('pnpm install', siteType);
  await execAsync(`pnpm link ${pathToPackage('cli')}`, siteType);
  await execAsync(`pnpm link ${pathToPackage('lib')}`, siteType);

  if (siteType === 'nextjs-site') {
    await execAsync(`pnpm link ${pathToPackage('react')}`, siteType);
  } else if (siteType === 'sveltekit-site') {
    await execAsync(`pnpm link ${pathToPackage('svelte')}`, siteType);
  }

  await execAsync('pnpm update-ontologies', siteType);
}

function startServer(siteType: string) {
  // Adjust runtime commands per template
  const command =
    siteType === 'nextjs-site'
      ? 'pnpm build && pnpm start'
      : 'pnpm run build && NO_COLOR=1 pnpm preview';

  return spawn(command, {
    cwd: path.join(EXEC_DIR, siteType),
    shell: true,
  });
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

      const match = message.match(/http:\/\/localhost:\d+/);

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
  test.beforeEach(before);

  test('apply next-js template', async ({ page }) => {
    test.slow();
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

    await setupTemplateSite(drive.driveURL, 'nextjs-site');

    try {
      //start server
      const child = startServer('nextjs-site');
      const url = await waitForServer(child);

      // check if the server is running
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);

      // Check if home is following wcag AA standards
      const homeScanResults = await new AxeBuilder({ page }).analyze();

      expect(homeScanResults.violations).toEqual([]);

      await expect(page.locator('body')).toContainText(
        'This is a template site generated with @tomic/template.',
      );

      await page.goto(`${url}/blog`);

      // Check if blog is following wcag AA standards
      const blogScanResults = await new AxeBuilder({ page }).analyze();
      expect(blogScanResults.violations).toEqual([]);

      // Search for a blogpost
      const searchInput = page.getByRole('searchbox');

      await searchInput.fill('balloon');
      await expect(page.locator('body')).toContainText('Balloon');
      await expect(page.locator('body')).not.toContainText('coffee');
    } finally {
      try {
        await kill(3000);
        log('Next.js server shut down successfully');
      } catch (err) {
        console.error('Failed to shut down Next.js server:', err);
      }
    }
  });

  test('apply sveltekit template', async ({ page }) => {
    test.slow();
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

    try {
      const child = startServer('sveltekit-site');
      //start server
      const url = await waitForServer(child);

      // check if the server is running
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);

      // Check if home is following wcag AA standards
      const homeScanResults = await new AxeBuilder({ page }).analyze();

      expect(homeScanResults.violations).toEqual([]);

      await expect(page.locator('body')).toContainText(
        'This is a template site generated with @tomic/template.',
      );

      await page.goto(`${url}/blog`);

      // Check if blog is following wcag AA standards
      const blogScanResults = await new AxeBuilder({ page }).analyze();
      expect(blogScanResults.violations).toEqual([]);

      // Search for a blogpost
      const searchInput = page.getByRole('searchbox');
      await searchInput.fill('balloon');
      await expect(page.locator('body')).toContainText('Balloon');
      await expect(page.locator('body')).not.toContainText('coffee');
    } finally {
      try {
        await kill(4174);
        log('SvelteKit server shut down successfully');
        // We need to wait for the process to be killed and playwright does not wait unless there is another expect coming.
        expect(true).toBe(true);
      } catch (err) {
        console.error('Failed to shut down SvelteKit server:', err);
      }
    }
  });

  test.afterAll(async () => {
    if (!fs.existsSync(EXEC_DIR)) {
      // eslint-disable-next-line no-console
      console.log('No EXEC_DIR to delete, skipping...');

      return;
    }

    try {
      await fs.promises.rm(EXEC_DIR, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to delete ${EXEC_DIR}:`, error);
    }
  });
});
