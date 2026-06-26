import { test, expect } from '@playwright/test';
import {
  getDevDriveSecret,
  newResource,
  editTitle,
  makeDrivePublic,
  timestamp,
  before,
  setTitle,
} from './test-utils';

test.describe('diag', () => {
  test.beforeEach(before);

  test('slash menu diag', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    page.on('console', m => {
      if (m.type() === 'error' || m.type() === 'warning') {
        errors.push(`[${m.type()}] ${m.text()}`);
      }
    });
    page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
    await getDevDriveSecret(page);
    await makeDrivePublic(page);
    await newResource('folder', page);
    await setTitle(page, 'SomeFolder');
    await newResource('document', page);
    await editTitle(`Document ${timestamp()}`, page);

    await expect(page.getByText('loading...')).not.toBeVisible();
    const editor = page.getByLabel('Rich Text Editor');
    await expect(editor).toBeVisible({ timeout: 30000 });

    console.log('DIAG editor count =', await editor.count());

    // Real keystrokes (not fill)
    await editor.first().click();
    await page.keyboard.type('/');
    await page.waitForTimeout(400);
    console.log(
      'DIAG after "/" — command list visible?',
      await page.getByTestId('rte-command-list').isVisible().catch(() => 'no-testid'),
    );
    console.log(
      'DIAG editor HTML =',
      await editor.first().innerHTML(),
    );
    await page.keyboard.type('heading');
    await page.waitForTimeout(400);
    const headingVisible = await page
      .getByText('Heading 1')
      .isVisible()
      .catch(() => false);
    console.log('DIAG "Heading 1" visible after keyboard type =', headingVisible);
    console.log('DIAG editor HTML2 =', await editor.first().innerHTML());
    console.log('DIAG ERRORS after "/":\n' + errors.join('\n'));

    // Now also test fill (what the real test does)
    await editor.first().click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await editor.first().fill('/heading');
    await page.waitForTimeout(400);
    const headingViaFill = await page
      .getByText('Heading 1')
      .isVisible()
      .catch(() => false);
    console.log('DIAG "Heading 1" visible after FILL =', headingViaFill);
    console.log('DIAG editor HTML3 =', await editor.first().innerHTML());
  });
});
