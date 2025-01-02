import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execSync } from 'child_process';
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

const TEMPLATE_DIR_NAME = 'template-tests';

test.describe.configure({ mode: 'serial' });

const waitForNextServer = (
  childProcess: ChildProcess,
  timeout = 30000,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      childProcess.kill(); // Kill the process if it times out
      reject(new Error('Next.js server took too long to start.'));
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
        reject(
          new Error(`Next.js server encountered an error: ${errorMessage}`),
        );
      }
    });

    childProcess.on('exit', code => {
      clearTimeout(timeoutId); // Clear the timeout when the process exits

      if (code !== 0) {
        reject(new Error(`Next.js server process exited with code ${code}`));
      }
    });
  });
};

test.describe('Create Next.js Template', () => {
  test.beforeEach(before);

  test('apply template', async ({ page }) => {
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

    if (!fs.existsSync(TEMPLATE_DIR_NAME)) {
      fs.mkdirSync(TEMPLATE_DIR_NAME);
    }

    execSync('pnpm link ../create-template');
    execSync(
      `pnpm exec create-template ${TEMPLATE_DIR_NAME}/nextjs-template --template nextjs-site --server-url ${drive.driveURL}`,
    );
    execSync(`pnpm install`, {
      cwd: `${TEMPLATE_DIR_NAME}/nextjs-template`,
    });
    execSync('pnpm link ../../../cli', {
      cwd: `${TEMPLATE_DIR_NAME}/nextjs-template`,
    });
    execSync('pnpm link ../../../lib', {
      cwd: `${TEMPLATE_DIR_NAME}/nextjs-template`,
    });
    execSync('pnpm link ../../../react', {
      cwd: `${TEMPLATE_DIR_NAME}/nextjs-template`,
    });

    execSync(`pnpm update-ontologies`, {
      cwd: `${TEMPLATE_DIR_NAME}/nextjs-template`,
    });

    const child = spawn('pnpm run build && pnpm start', {
      cwd: `${TEMPLATE_DIR_NAME}/nextjs-template`,

      shell: true,
    });

    try {
      //start server
      const url = await waitForNextServer(child);

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
      const searchInput = page.locator(
        'input[aria-label="Search blogposts..."]',
      );
      await searchInput.fill('balloon');
      await expect(page.locator('body')).toContainText('Balloon');
      await expect(page.locator('body')).not.toContainText('coffee');
    } finally {
      child.kill();
    }
  });

  test.afterEach(async () => {
    const dirPath = path.join(__dirname, '..', TEMPLATE_DIR_NAME);

    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to delete ${TEMPLATE_DIR_NAME}:`, error);
    }

    await kill(3000);
  });
});
