import { test as setup, expect } from '@playwright/test';
import {
  before,
  DELETE_PREVIOUS_TEST_DRIVES,
  SERVER_URL,
  signIn,
} from './test-utils';
import fs from 'node:fs';
import path from 'node:path';

setup('delete previous test data', async ({ page }) => {
  setup.slow();

  await page.goto(SERVER_URL);
  
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      @media (prefers-reduced-motion: no-preference) {
        * {
          animation-duration: 0s !important;
          transition-duration: 0s !important;
        }
      }
    `
  });

  await before({ page });
  await signIn(page);
  
  if (DELETE_PREVIOUS_TEST_DRIVES) {
    await page.goto(`${SERVER_URL}/app/prunetests`);
    await expect(page.getByText('Prune Test Data')).toBeVisible();
    await page.getByRole('button', { name: 'Prune' }).click();
    await expect(page.getByTestId('prune-result')).toBeVisible();
  }
  
  const authDir = path.join(__dirname, '..', 'playwright', '.auth');
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
  
  await page.context().storageState({ path: path.join(authDir, 'user.json') });
});
