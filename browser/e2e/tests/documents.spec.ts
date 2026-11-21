import { test, expect } from '@playwright/test';
import { Agent, Store } from '@tomic/lib';
import { testAgentSecret } from '../test-agent';
import { SERVER_URL } from '../test-environment';
import {
  signIn,
  newDrive,
  newResource,
  editTitle,
  getCurrentSubject,
  makeDrivePublic,
  openNewSubjectWindow,
  timestamp,
  before,
  setTitle,
} from './test-utils';
test.describe('documents', async () => {
  test.beforeEach(before);

  test('create document, edit, page title, websockets', async ({
    page,
    browser,
  }) => {
    const folderTitle = 'SomeFolder';

    await signIn(page);
    const { driveURL } = await newDrive(page);
    await makeDrivePublic(page);
    // Create a document
    await newResource('folder', page);
    await setTitle(page, folderTitle);
    const folderSubject = await getCurrentSubject(page);
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
    const page2 = await openNewSubjectWindow(browser, currentSubject!, true);

    await page2.getByRole('button', { name: 'Set Drive' }).click();
    await expect(page2.getByText('loading...')).not.toBeVisible();
    await expect(
      page2.getByRole('heading', { name: teststring }),
      'First paragraph title not visible in second tab. Not a websocket issue',
    ).toBeVisible();
    expect(await page2.title()).toEqual(title);

    // Collapse the selection at the end of the heading before splitting it.
    // The initial editor caret depends on which collaborator connected first.
    await page2
      .getByLabel('Rich Text Editor')
      .getByRole('heading', { name: teststring })
      .selectText();
    await page2.keyboard.press('ArrowRight');
    await page2.keyboard.press('Enter');
    // Type on the second device and observe the new paragraph on the first.
    const syncText = 'New paragraph';
    await page2.keyboard.type(syncText);

    await expect(
      page.locator(`text=${syncText}`),
      'New paragraph not found in first window. Sync might not be working.',
    ).toBeVisible();

    // The remote cursor label can be a child of this paragraph.
    const paragraph = page2
      .getByLabel('Rich Text Editor')
      .locator('p')
      .filter({ hasText: syncText });
    await paragraph.selectText();

    // Test if page1 can see the cursor of page2
    await expect(
      page
        .getByLabel('Rich Text Editor')
        .getByText('Test User', { exact: true }),
    ).toBeVisible();

    // Replace the selected paragraph through the editor on the second device.
    // Selection is explicit because word-deletion shortcuts differ by platform.
    await paragraph.selectText();
    await page2.keyboard.type('New');
    await expect(
      page
        .getByLabel('Rich Text Editor')
        .locator('p')
        .filter({ hasText: /^New/ }),
    ).toBeVisible();

    await expect(
      page.locator(`text=${syncText}`),
      'Paragraph not deleted in first window.',
    ).not.toBeVisible();
    await expect(
      page2.locator(`text=${syncText}`),
      'Paragraph not deleted in second window',
    ).not.toBeVisible();

    // Mentions issue one search as the text changes. Wait for this drive's
    // folder to be searchable before asking the editor to find it.
    const searchStore = new Store({
      serverUrl: SERVER_URL,
      agent: Agent.fromSecret(await testAgentSecret(), 'js'),
    });
    await expect
      .poll(
        () =>
          searchStore.search(folderTitle.toLowerCase(), {
            parents: [driveURL],
            limit: 10,
          }),
        { timeout: 30_000 },
      )
      .toContain(folderSubject);
    // Add a link to a folder to the document
    await page2.keyboard.press('Space');
    await page2.keyboard.type('@');
    await page2.keyboard.type(folderTitle, { delay: 50 });
    await expect(
      page2.getByTestId('rte-command-list').getByText(folderTitle),
    ).toBeVisible();
    await page2.keyboard.press('Enter');

    // Check if the link is visible in the document
    await expect(
      page.getByLabel('Rich Text Editor').locator('a:has-text("SomeFolder")'),
    ).toBeVisible();
  });
});
