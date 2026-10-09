import { test, expect, type Page } from './fixtures';
import {
  before,
  devDrive,
  fillSearchBox,
  getCurrentSubject,
  newResource,
  openSubject,
  setTitle,
  topBarShareButton,
  waitForSynced,
} from './test-utils';

/** Can the signed-in agent of `page` read `subject` on the server right now? */
async function canRead(page: Page, subject: string): Promise<boolean> {
  return page.evaluate(async s => {
    try {
      const resource = await window.store.fetchResourceFromServer(s, {
        forceOverride: true,
      });

      return !resource.error;
    } catch {
      return false;
    }
  }, subject);
}

test.describe('groups', () => {
  test.beforeEach(before);

  test('share a folder with a group, then take the member out', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);

    // The second agent: its own context, so its own agent and drive.
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await devDrive(guest);
    const guestAgent = await guest.evaluate(
      () => window.store.getAgent()!.subject,
    );

    // The thing to share.
    await newResource('folder', page);
    const folder = await getCurrentSubject(page);
    await setTitle(page, 'Quarterly plans');
    await waitForSynced(page);
    expect(await canRead(guest, folder)).toBe(false);

    // Create a group from the normal New flow and rename it.
    await newResource('Group', page);
    await expect(page.getByTestId('group-members')).toBeVisible();
    const group = await getCurrentSubject(page);
    await setTitle(page, 'Design team');

    // Add the second agent by pasting their agent URL.
    const members = page.getByTestId('group-members');
    await expect(members.getByTestId('group-member')).toHaveCount(1);
    await fillSearchBox(page, /Search for a person/, guestAgent);
    await page.keyboard.press('Enter');
    await expect(members.getByTestId('group-member')).toHaveCount(2);
    await expect(
      members.locator(`[data-subject="${guestAgent}"]`),
    ).toBeVisible();
    await waitForSynced(page);

    // Share the folder with the group.
    await openSubject(page, folder);
    await topBarShareButton(page).click();
    const fullName = page.getByLabel('Full name', { exact: true });

    if (
      await fullName.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      )
    ) {
      await fullName.fill('Group Owner');
      await page
        .getByRole('button', { name: 'Save and continue', exact: true })
        .click();
    }

    const dialog = page.getByRole('dialog');
    await expect(async () => {
      const pick = await fillSearchBox(
        dialog,
        'Search for a group...',
        'Design',
      );
      await pick('Design team');
    }).toPass({ timeout: 30_000 });

    const row = dialog.getByTestId('share-group');
    await expect(row).toContainText('Design team');
    await expect(row).toContainText('2 members');
    await waitForSynced(page);

    // The group's members can now open the folder.
    await expect
      .poll(() => canRead(guest, folder), { timeout: 20_000 })
      .toBe(true);

    // "Show" lists who the group covers.
    await row.getByRole('button', { name: 'Show' }).click();
    await expect(dialog.getByTestId('share-group-covered')).toContainText(
      'Group Owner',
    );
    await dialog.getByRole('button', { name: 'Done' }).click();

    // Taking them out of the group takes the access away.
    await openSubject(page, group);
    await page
      .locator(`[data-subject="${guestAgent}"]`)
      .getByTestId('group-member-remove')
      .click();
    await expect(
      page.getByTestId('group-members').getByTestId('group-member'),
    ).toHaveCount(1);
    await waitForSynced(page);
    await expect
      .poll(() => canRead(guest, folder), { timeout: 20_000 })
      .toBe(false);

    // And removing the group from the share dialog works too.
    await openSubject(page, folder);
    await topBarShareButton(page).click();
    const dialog2 = page.getByRole('dialog');
    await dialog2
      .getByTestId('share-group')
      .getByRole('combobox', { name: 'Access for Design team' })
      .selectOption('remove');
    await expect(dialog2.getByTestId('share-group')).toHaveCount(0);

    await guestContext.close();
  });
});
