import { test } from '@playwright/test';
import { devDrive } from './test-utils';

test('what is connection-refused', async ({ page }) => {
  const failed: string[] = [];
  page.on('requestfailed', r => {
    const f = r.failure();
    if (f && /REFUSED|CONNECTION/.test(f.errorText)) {
      failed.push(`${f.errorText}  ${r.url().slice(0, 90)}`);
    }
  });
  await devDrive(page);
  await page.goto(page.url());
  await page.waitForTimeout(5000);
  // eslint-disable-next-line no-console
  console.log('FAILED_REQS', JSON.stringify([...new Set(failed)].slice(0, 10)));
});
