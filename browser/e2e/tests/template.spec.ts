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
import { promisify } from 'util';
import { log } from 'node:console';

const execAsync = promisify(exec);
const TEMPLATE_DIR_NAME = 'template-tests';
// test.describe.configure({ mode: 'serial' });

async function setupTemplateSite(
  templateDir: string,
  serverUrl: string,
  siteType: string,
) {
  if (!fs.existsSync(templateDir)) {
    fs.mkdirSync(templateDir);
  }

  await execAsync('pnpm link ../create-template');
  await execAsync(
    `pnpm exec create-template ${templateDir}/${siteType} --template ${siteType} --server-url ${serverUrl}`,
  );

  const sitePath = `${templateDir}/${siteType}`;
  await execAsync('pnpm install', { cwd: sitePath });
  await execAsync('pnpm link ../../../cli', { cwd: sitePath });
  await execAsync('pnpm link ../../../lib', { cwd: sitePath });

  if (siteType === 'nextjs-site') {
    await execAsync('pnpm link ../../../react', { cwd: sitePath });
  } else if (siteType === 'sveltekit-site') {
    await execAsync('pnpm link ../../../svelte', { cwd: sitePath });
  }

  await execAsync('pnpm update-ontologies', { cwd: sitePath });
}

function startServer(templateDir: string, siteType: string) {
  // Adjust runtime commands per template
  const command =
    siteType === 'nextjs-site'
      ? 'pnpm run build && pnpm start'
      : 'pnpm run build && NO_COLOR=1 pnpm preview';

  return spawn(command, {
    cwd: `${templateDir}/${siteType}`,
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

test.describe('Create Next.js Template', () => {
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

    await setupTemplateSite(TEMPLATE_DIR_NAME, drive.driveURL, 'nextjs-site');

    try {
      //start server
      const child = startServer(TEMPLATE_DIR_NAME, 'nextjs-site');
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

  test.afterEach(async () => {
    const dirPath = path.join(
      __dirname,
      '..',
      TEMPLATE_DIR_NAME,
      'nextjs-site',
    );

    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to delete ${TEMPLATE_DIR_NAME}:`, error);
    }
  });
});

test.describe('Create SvelteKit Template', () => {
  test.beforeEach(before);

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

    await setupTemplateSite(
      TEMPLATE_DIR_NAME,
      drive.driveURL,
      'sveltekit-site',
    );

    try {
      const child = startServer(TEMPLATE_DIR_NAME, 'sveltekit-site');
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

  test.afterEach(async () => {
    const dirPath = path.join(
      __dirname,
      '..',
      TEMPLATE_DIR_NAME,
      'sveltekit-site',
    );

    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to delete ${TEMPLATE_DIR_NAME}:`, error);
    }
  });
});
