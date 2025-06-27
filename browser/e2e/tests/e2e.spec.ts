import { test, expect, type Page } from '@playwright/test';
import {
  FRONTEND_URL,
  SERVER_URL,
  before,
  changeDrive,
  contextMenuClick,
  currentDialogOkButton,
  currentDriveTitle,
  editProfileAndCommit,
  editTitle,
  editableTitle,
  getCurrentSubject,
  newDrive,
  newResource,
  openConfigureDrive,
  openNewSubjectWindow,
  openSubject,
  publicReadRightLocator,
  setTitle,
  signIn,
  timestamp,
  waitForCommit,
  openAgentPage,
  fillSearchBox,
  clickSidebarItem,
  inDialog,
  acceptInvite,
  topBarShareButton,
} from './test-utils';

test.describe('data-browser', async () => {
  test.beforeEach(before);

  test('sidebar mobile', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 800 });
    await page.reload();
    await page.click('[data-test="sidebar-toggle"]');
    await expect(currentDriveTitle(page)).toBeVisible();
  });

  test('switch Server URL', async ({ page }) => {
    await changeDrive('https://atomicdata.dev', page);
    await expect(currentDriveTitle(page)).toContainText('atomicdata.dev');
  });

  test('sign in with secret, edit profile, sign out', async ({ page }) => {
    await signIn(page);
    await editProfileAndCommit(page);

    page.on('dialog', d => {
      d.accept();
    });

    await openAgentPage(page);
    await page.click('[data-test="sign-out"]');
    await expect(
      page.getByRole('button', { name: 'Create account' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Create account' }),
    ).toBeVisible();
  });

  /**
   * We remove public read rights from drive, create an invite, open that
   * invite, and add the public read right again.
   */
  test('authorization, invite, share menu', async ({
    page,
    browser,
    context,
  }) => {
    await signIn(page);
    const { driveURL, driveTitle } = await newDrive(page);
    await currentDriveTitle(page).click();
    await contextMenuClick('share', page);
    expect(publicReadRightLocator(page)).not.toBeChecked();

    // Initialize unauthorized page for reader
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.setViewportSize({ width: 1000, height: 400 });
    await page2.goto(FRONTEND_URL);
    await openSubject(page2, driveURL);
    await expect(page2.locator('text=Unauthorized').first()).toBeVisible();

    // Create invite
    await page.click('button:has-text("Create Invite")');
    context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('button:has-text("Create")');
    await expect(page.locator('text=Invite created and copied ')).toBeVisible();
    const inviteUrl = await page.evaluate(() =>
      document
        ?.querySelector('[data-code-content]')
        ?.getAttribute('data-code-content'),
    );
    expect(inviteUrl).not.toBeFalsy();

    await page.waitForTimeout(200);

    // Open invite
    const page3 = await openNewSubjectWindow(browser, inviteUrl as string);
    await acceptInvite(page3);
    await page3.waitForURL(/\/app\/show/, { timeout: 15000 });
    await page3.reload();
    await expect(page3.getByText(driveTitle).first()).toBeVisible();
  });

  test('chatroom', async ({ page, browser, context }) => {
    const inputLocator = (currentPage: Page) =>
      currentPage.getByLabel('Chat input');

    await newResource('chatroom', page);
    // EditableTitle auto-focuses on creation; type a title and press Enter.
    // Focus should then move to the chat input.
    await page.keyboard.type('Test Chat');
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Test Chat' }),
    ).toBeVisible();
    await expect(inputLocator(page)).toBeFocused();
    const teststring = `My test: ${timestamp()}`;
    await inputLocator(page).fill(teststring);
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(
      inputLocator(page),
      'Text input not cleared after send',
    ).toHaveText('');
    await expect(
      page.locator(`text=${teststring}`),
      'Chat message not appearing directly after sending',
    ).toBeVisible({ timeout: 15_000 });

    // Prefer the owner’s real location bar href when it is already /app/show?subject=…; otherwise build the
    // same URL from `main[about]` (resolved subject, e.g. DID) so the guest opens the right resource.
    const chatSubject = await getCurrentSubject(page);
    const ownerLoc = new URL(page.url());
    const showFallback = new URL('/app/show', FRONTEND_URL);
    showFallback.searchParams.set('subject', chatSubject);
    const chatRoomHref =
      ownerLoc.pathname.endsWith('/app/show') &&
      ownerLoc.searchParams.get('subject')
        ? ownerLoc.href
        : showFallback.href;

    // Owner: Share → invite. Guest: open invite URL only (new agent via acceptInvite).
    await topBarShareButton(page).click();
    await expect(
      page.getByRole('button', { name: 'Create Invite' }),
    ).toBeVisible({ timeout: 10000 });

    context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(FRONTEND_URL).origin,
    });
    await page.getByRole('button', { name: 'Create Invite' }).click();
    await page.getByLabel('Allow edits').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('text=Invite created and copied ')).toBeVisible();
    const inviteUrl = await page.evaluate(() =>
      document
        .querySelector('[data-code-content]')
        ?.getAttribute('data-code-content'),
    );
    expect(inviteUrl).toBeTruthy();

    const context2 = await browser.newContext();
    await context2.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(FRONTEND_URL).origin,
    });
    const page2 = await context2.newPage();
    await page2.goto(inviteUrl as string);

    await acceptInvite(page2);
    await page2.waitForURL(/\/app\//, { timeout: 15_000 });
    try {
      await expect(page2.locator(`text=${teststring}`)).toBeVisible({
        timeout: 10_000,
      });
    } catch {
      // Redirect may land outside the chatroom; open the same /app/show?subject=… URL as the owner.
      await page2.waitForTimeout(500);
      await page2.goto(chatRoomHref);
      await expect(page2.locator(`text=${teststring}`)).toBeVisible({
        timeout: 15_000,
      });
    }

    await expect(page2.getByTestId('current-drive-title')).toContainText(
      "'s Drive",
    );
    await expect(page2.getByTestId('shared-with-me')).toBeVisible();
    await expect(
      page2.getByTestId('shared-with-me').getByTestId('shared-with-me-item'),
    ).toContainText('Test Chat');

    const teststring2 = `My reply: ${timestamp()}`;
    await inputLocator(page2).fill(teststring2);
    await expect(page2.getByRole('button', { name: 'Send' })).toBeEnabled();
    await page2.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator(`text=${teststring2}`)).toBeVisible();
    await expect(page2.locator(`text=${teststring2}`)).toBeVisible();
  });

  test('bookmark', async ({ page }) => {
    await newResource('bookmark', page);

    const input = page.locator('[placeholder="https\\:\\/\\/example\\.com"]');
    await input.click();
    await input.fill('https://ontola.io');
    await page.locator(currentDialogOkButton).click();

    await expect(
      page.locator(':text-is("Full-service")'),
      'Page contents not properly imported',
    ).toBeVisible();
  });

  test('quick edit text typing ux', async ({ page }) => {
    await newResource('folder', page);

    // We automatically focus the title input after creating a new resource.
    // await editableTitle(page).click();

    const alphabet = 'abcdefghijklmnopqrstuvwxyz';

    // Set up listener BEFORE typing so it catches commits sent during the delay
    // between keystrokes (debounce fires during type()'s delay option).
    const firstCommit = waitForCommit(page);

    for (const letter of alphabet) {
      await editableTitle(page).type(letter, { delay: Math.random() * 300 });
    }

    // Wait long enough for the final debounce (100ms) + network round-trip.
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    await expect(
      page.locator(`text=${alphabet}`).first(),
      'String not correct after typing, bad typing UX. Maybe views are notified of changes twice?',
    ).toBeVisible();

    // Ensure at least one commit reached the server (proves saving is working).
    await firstCommit;

    await page.reload();
    await expect(
      page.locator(`text=${alphabet}`).first(),
      'Text not correct after reload',
    ).toBeVisible();
  });

  test('folder', async ({ page }) => {
    await newResource('folder', page);

    // Create a sub-resource in the folder
    await page
      .getByRole('main')
      .getByRole('button', { name: 'New Resource', exact: true })
      .click();
    await page.click('button:has-text("Document")');
    await editableTitle(page).click();
    await page.keyboard.type('RAM Downloading Strategies');
    await page.keyboard.press('Enter');
    await clickSidebarItem('Folder', page);
    await expect(
      page.locator(
        '[data-test="folder-list"] >> text=RAM Downloading Strategies',
      ),
      'Created document not visible',
    ).toBeVisible();
  });

  test('folder title auto-edits on creation', async ({ page }) => {
    await newResource('folder', page);
    await expect(editableTitle(page)).toHaveRole('textbox');
  });

  test('configure drive page', async ({ page }) => {
    await signIn(page);
    await openConfigureDrive(page);
    const expectedTitle = new URL(SERVER_URL);
    await expect(currentDriveTitle(page)).toContainText(expectedTitle.hostname);

    await openConfigureDrive(page);
    await changeDrive('https://example.com', page, false);
    await expect(currentDriveTitle(page)).toHaveText('example.com/');

    // Switch back to localhost
    await openConfigureDrive(page);
    await changeDrive(SERVER_URL, page);
    await expect(currentDriveTitle(page)).toContainText(expectedTitle.hostname);
  });

  test('form validation', async ({ page }) => {
    await newResource('https://atomicdata.dev/classes/Class', page);
    const shortnameInput = '[data-test="input-shortname"]';
    await page.click(shortnameInput);
    await page.keyboard.type('not valid-');
    await page.locator(shortnameInput).blur();
    await expect(page.getByText('Invalid Slug')).toBeVisible();
    await page.locator(shortnameInput).fill('');
    await page.keyboard.type('is-valid');
    await expect(page.locator('text=Not a valid slug')).not.toBeVisible();
    await page.getByRole('button', { name: 'advanced' }).click();
    await fillSearchBox(
      page,
      'Search for a property or enter a URL',
      'https://atomicdata.dev/properties/invite/usagesLeft',
    );
    await page.keyboard.press('Enter');
    await expect(page.locator('text=Usages-left').first()).toBeVisible();
    // Integer validation
    await page.click('[data-test="input-usages-left"]');
    await page.keyboard.type('asdf1');
    await expect(page.locator('text=asdf')).not.toBeVisible();

    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await page.getByLabel('Description').click();
    await page.keyboard.type('This is a test class');
    await page.click('button:has-text("Save")');

    await expect(page.locator('text=Resource Saved')).toBeVisible();
  });

  test('delete resource', async ({ page }) => {
    await newResource('folder', page);
    const parentResource = await getCurrentSubject(page);
    await page.click('button:has-text("New Resource")');
    await page.click('button:has-text("folder")');
    const nestedResource = await getCurrentSubject(page);
    await openSubject(page, parentResource);
    await contextMenuClick('delete', page);
    await page.click('button:has-text("Delete")');

    await expect(page.locator('text=Resource deleted')).toBeVisible();

    await page.reload();
    await openSubject(page, nestedResource);

    await expect(
      page.locator('text=Resource not found'),
      'Nested resource not deleted',
    ).toBeVisible();
  });

  test('sidebar subresource', async ({ page }) => {
    const klass = 'folder';
    await newResource(klass, page);
    await expect(page.getByTestId('sidebar').getByText(klass)).toBeVisible();
    const d0 = 'depth0';
    await setTitle(page, d0);

    await page.getByTestId('new-resource-folder').click();
    await page.click(`button:has-text("${klass}")`);
    const d1 = 'depth1';

    await setTitle(page, d1);

    await expect(
      page.getByTestId('sidebar').getByText(d0),
      "Sidebar doesn't show updated parent resource title",
    ).toBeVisible();
    await expect(
      page.getByTestId('sidebar').getByText(d1),
      "Sidebar doesn't show child resource title",
    ).toBeVisible();
    await page.waitForTimeout(500);
    await page.reload();
    await expect(
      page.getByTestId('sidebar').getByText(d1),
      "Sidebar doesn't show parent resource resource title after refresh",
    ).toBeVisible();
    await expect(
      page.getByTestId('sidebar').getByText(d0),
      "Sidebar doesn't show child resource title after refresh",
    ).toBeVisible();
  });

  test('import', async ({ page }) => {
    await newResource('folder', page);
    await contextMenuClick('import', page);

    const parentSubject = await page.getByLabel('Target Parent').inputValue();

    const localID = 'localIDtest';
    const name = 'blaat';
    const importStr = {
      'https://atomicdata.dev/properties/localId': localID,
      'https://atomicdata.dev/properties/name': name,
    };
    await expect(page.getByRole('button', { name: 'Import' })).toBeDisabled();
    await page
      .getByPlaceholder('Paste your JSON-AD...')
      .pressSequentially(JSON.stringify(importStr));
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.locator('text=Imported!')).toBeVisible();

    await page.goto(parentSubject + '/' + localID);
    await expect(page.getByRole('heading', { name })).toBeVisible();
  });

  test('dialog', async ({ page }) => {
    await newResource('https://atomicdata.dev/classes/Class', page);

    await page.getByLabel('Shortname').fill('test-shortname');
    await page.getByLabel('Description').fill('test-description');
    await page.getByRole('button', { name: 'Save' }).click();
    await contextMenuClick('edit', page);

    await page
      .locator('[title="Add an item to the recommends list"]')
      .first()
      .click();

    const clickOption = await fillSearchBox(
      page,
      'Search for a property or enter a URL',
      'test-prop',
      { nth: 0 },
    );

    await clickOption('Create test-prop');

    await inDialog(page, async (dialog, closeDialogWith) => {
      await expect(
        dialog.getByRole('heading', { name: 'new property' }),
      ).toBeVisible();

      const selectDatatypeOption = await fillSearchBox(
        dialog,
        'Datatype',
        'boolean',
      );
      await selectDatatypeOption('booleanEither `true` or `false`');

      await dialog.getByLabel('Description').fill('This is a test prop');

      await closeDialogWith('Save');
    });

    await expect(
      page.getByRole('button', { name: 'test-prop', exact: true }),
    ).toBeVisible();
  });

  test('history page', async ({ page }) => {
    await newResource('document', page);

    const firstTitleCommit = waitForCommit(page, {
      set: {
        ['https://atomicdata.dev/properties/name']: 'First Title',
      },
    });

    await editTitle('First Title', page);
    await firstTitleCommit;

    await expect(
      page.getByRole('heading', { name: 'First Title', level: 1 }),
    ).toBeVisible();

    const secondTitleCommit = waitForCommit(page, {
      set: {
        ['https://atomicdata.dev/properties/name']: 'Second Title',
      },
    });
    await editTitle('Second Title', page);
    await secondTitleCommit;

    await expect(
      page.getByRole('heading', { name: 'Second Title', level: 1 }),
    ).toBeVisible();

    await contextMenuClick('history', page);

    await expect(page.locator('text=History of Second Title')).toBeVisible();

    await page.getByTestId('version-button').nth(1).click();

    await expect(page.locator('text=First Title')).toBeVisible();

    await page.click('text=Make current version');

    await expect(page.locator('text=Resource version updated')).toBeVisible();
    await expect(page.locator('h1:has-text("First Title")')).toBeVisible();
    await expect(page.locator('text=History of First Title')).not.toBeVisible();
  });
});
