import { test, expect } from '@playwright/test';
import {
  getDevDriveSecret,
  newResource,
  editTitle,
  getCurrentSubject,
  makeDrivePublic,
  openNewSubjectWindow,
  timestamp,
  before,
  setTitle,
  waitForSearchIndex,
} from './test-utils';

test.describe('documents', async () => {
  test.beforeEach(before);

  test('create document, edit, page title, websockets', async ({
    page,
    browser,
  }) => {
    const folderTitle = 'SomeFolder';

    const secret = await getDevDriveSecret(page);
    await makeDrivePublic(page);
    await newResource('folder', page);
    await setTitle(page, folderTitle);
    await newResource('document', page);
    const title = `Document ${timestamp()}`;
    await editTitle(title, page);

    const teststring = `My test: ${timestamp()}`;

    await expect(page.getByText('loading...')).not.toBeVisible();

    const editor = page.getByLabel('Rich Text Editor');

    await editor.fill('/heading');
    await expect(page.getByText('Heading 1')).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.type(teststring);

    await expect(page.getByRole('heading', { name: teststring })).toBeVisible();

    // multi-user
    const currentSubject = await getCurrentSubject(page);
    const page2 = await openNewSubjectWindow(browser, currentSubject!, secret);

    // "Set Drive" historically appeared when opening a foreign-drive subject;
    // proper sign-in already sets the drive, so the button often isn't there.
    // Click only when present, ignore otherwise.
    const setDriveButton = page2.getByRole('button', { name: 'Set Drive' });
    if (await setDriveButton.isVisible({ timeout: 1500 }).catch(() => false)) {
      await setDriveButton.click();
    }
    await expect(page2.getByText('loading...')).not.toBeVisible();
    await expect(
      page2.getByRole('heading', { name: teststring }),
      'First paragraph title not visible in second tab. Not a websocket issue',
    ).toBeVisible();
    expect(await page2.title()).toEqual(title);

    await page2.getByLabel('Rich Text Editor').focus();
    await page2.keyboard.press('ArrowDown');
    await page2.waitForTimeout(50);
    await page2.keyboard.press('Enter');
    const syncText = 'New paragraph';
    await page2.keyboard.type(syncText);

    await expect(
      page2.locator(`text=${syncText}`),
      'New paragraph not found after typing. Something is wrong with rendering the text / handling the keyboard.',
    ).toBeVisible();

    await expect(
      page.locator(`text=${syncText}`),
      'New paragraph not found in first window. Sync might not be working.',
    ).toBeVisible();

    // Test if page1 can see the cursor of page2
    await page2.getByText(syncText).selectText();

    // Not sure what this is supposed to do, but this text does not show up.
    // Perhaps I need 2 differetn agents?
    // await expect(
    //   page.getByLabel('Rich Text Editor').getByText('Test user edited'),
    // ).toBeVisible();

    // Delete the word with Alt+Backspace
    await page2.keyboard.press('ArrowRight');
    await page2.keyboard.down('Alt');
    await page2.keyboard.press('Backspace');
    await page2.keyboard.up('Alt');

    await expect(
      page.locator(`text=${syncText}`),
      'Paragraph not deleted in first window.',
    ).not.toBeVisible();
    await expect(
      page2.locator(`text=${syncText}`),
      'Paragraph not deleted in second window',
    ).not.toBeVisible();

    // Wait for AtomicServer to index the folder
    await waitForSearchIndex(page2);
    // Add a link to a folder via @ mention
    await page2.keyboard.press('Space');
    await page2.keyboard.type('@');
    await page2.waitForTimeout(500);
    await page2.keyboard.type(folderTitle, { delay: 50 });
    await expect(
      page2.getByTestId('rte-command-list').getByText(folderTitle),
    ).toBeVisible();
    await page2.keyboard.press('Enter');

    await expect(
      page.getByLabel('Rich Text Editor').locator('a:has-text("SomeFolder")'),
    ).toBeVisible();
  });
});
