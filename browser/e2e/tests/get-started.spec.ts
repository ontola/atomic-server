import { test, expect } from './fixtures';
import {
  FRONTEND_URL,
  devDrive,
  getDevDriveSecret,
  openNewSubjectWindow,
  editableTitle,
  sideBarDriveSwitcher,
} from './test-utils';

/**
 * A new visitor starts without an account: one tap makes a real identity on
 * this device, with its own drive, and opens it.
 */
test('Get started opens a workspace of your own, without an account', async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page).not.toHaveURL(/\/app\/welcome/, { timeout: 60_000 });

  // They land on the page of the ready-made drive: the Getting started panel
  // in the sidebar, the Welcome document as its first row.
  await expect(page.getByTestId('current-drive-title')).toHaveText(
    'Welcome to Atomic',
  );
  // Arriving is not an invitation to rename: the title is not being edited.
  await expect(
    page.locator('[data-testid="editable-title"]:focus'),
  ).toHaveCount(0);
  const panel = page.getByTestId('getting-started');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText('Getting started');
  await expect(panel).toContainText('0 of 6');

  for (const step of [
    'Read Start here',
    'Name your drive',
    'Make something',
    'Talk to the AI',
    'Invite someone',
    'Connect a device',
  ]) {
    await expect(panel.getByText(step, { exact: true })).toBeVisible();
  }

  // Every step can be started right away.
  await expect(
    panel.getByRole('button', { name: 'Invite someone' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('link', { name: 'Start here' }).first(),
  ).toBeVisible();
  const items = page.locator('[data-sidebar-id]');
  await expect(items).toHaveText(['Start here', 'Notes', 'Tasks', 'Sketch']);

  // Not a disposable guest: the agent has a personal drive of its own.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const store = window.store;
          const agent = store.getAgent();
          if (!agent?.subject) return undefined;

          const home = await agent.privateDriveSubject();
          const agentResource = await store.getResource(agent.subject);

          return {
            hasHome: !!agentResource.get(
              'https://atomicdata.dev/properties/personalDrive',
            ),
            // This server is a normal node, so the identity and its home
            // live on it. Local-only is for node-less origins (unit tests).
            localOnly:
              store.isLocalOnlyDrive(agent.subject) ||
              store.isLocalOnlyDrive(home),
          };
        }),
      { timeout: 30_000 },
    )
    .toEqual({ hasHome: true, localOnly: false });

  // The same identity survives a reload.
  const subject = await page.evaluate(() => window.store.getAgent()?.subject);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => window.store.getAgent()?.subject), {
      timeout: 30_000,
    })
    .toBe(subject);
  await expect(page).not.toHaveURL(/\/app\/welcome/);
});

test('The Getting started sidebar panel is open, folds away and opens again, also after a reload', async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const panel = page.getByTestId('getting-started');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');

  const fold = panel.getByRole('button', { name: /Collapse Getting started/ });
  await fold.click();
  await expect(panel.getByText('Name your drive')).toBeHidden();
  await expect(panel).toContainText('0 of 6');

  await page.reload();
  await expect(page.getByTestId('current-drive-title')).toHaveText(
    'Welcome to Atomic',
    { timeout: 30_000 },
  );
  // The panel needs the drive's rights and the agent's drive list before it
  // shows, so it arrives after the title. Wait for it folded, not for its
  // absence, or "hidden" passes before the panel has even rendered.
  const expand = panel.getByRole('button', { name: /Expand Getting started/ });
  await expect(expand).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText('Name your drive')).toBeHidden();

  await expand.click();
  await expect(panel.getByText('Name your drive')).toBeVisible();
});

test('Folding the Getting started panel is remembered for the user on another device', async ({
  page,
  browser,
}) => {
  test.slow();
  await devDrive(page);
  const secret = await getDevDriveSecret(page);
  // The panel shows on a drive of your own: make one.
  await sideBarDriveSwitcher(page).click();
  await page.getByTestId('menu-item-new-drive').click();
  await expect(page.getByTestId('current-drive-title')).toHaveText('My drive', {
    timeout: 30_000,
  });
  const panel = page.getByTestId('getting-started');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await panel.getByRole('button', { name: /Collapse Getting started/ }).click();
  await expect(panel.getByText('Name your drive')).toBeHidden();

  // The same agent on a second device: no local state, same drive.
  const other = await openNewSubjectWindow(browser, page.url(), secret);
  await other.getByRole('button', { name: 'Set as current drive' }).click();
  const otherPanel = other.getByTestId('getting-started');
  await expect(
    otherPanel.getByRole('button', { name: /Expand Getting started/ }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(otherPanel.getByText('Name your drive')).toBeHidden();
  await other.context().close();
});

test('A guest sees what to do next and the Save dialog opens in place', async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const panel = page.getByTestId('getting-started');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');

  // Not linked to an account: the panel's last row says so, with the next step.
  const row = panel.getByTestId('guest-save-row');
  await expect(row).toContainText('Only saved on this device');
  // Self-hosted, with no portal: nothing here asks for an email.
  await expect(row).toContainText('Connect a device');

  // Clicking it opens the dialog and leaves the page where it is.
  const drive = page.url();
  await row.click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Connect a device' }),
  ).toBeVisible();
  await expect(dialog).toContainText('saved on this device');
  await expect(page).toHaveURL(drive);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();
});

test('The sidebar drive header is split: the name opens the drive, the chevron the switcher', async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.getByTestId('getting-started')).toBeVisible({
    timeout: 60_000,
  });
  await page.keyboard.press('Escape');

  const sidebar = page.getByTestId('sidebar');
  const open = sidebar.getByRole('button', {
    name: 'Open Welcome to Atomic',
  });
  const switcher = sidebar.getByRole('button', { name: 'Switch Drive' });
  await expect(open).toBeVisible();
  await expect(switcher).toBeVisible();

  // The chevron opens the menu and leaves the page where it is.
  const here = page.url();
  await switcher.click();
  await expect(page.getByRole('menuitem', { name: 'New Drive' })).toBeVisible();
  await expect(page).toHaveURL(here);
  await page.keyboard.press('Escape');

  // The name goes to the drive's page.
  await sidebar.getByRole('button', { name: 'Start here' }).first().click();
  await expect(page).not.toHaveURL(here);
  await open.click();
  await expect(page).toHaveURL(here);
});

test('Creating a new drive leaves exactly one Getting started panel', async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const panels = page.getByTestId('getting-started');
  await expect(panels).toHaveCount(1, { timeout: 60_000 });
  await page.keyboard.press('Escape');

  await sideBarDriveSwitcher(page).click();
  await page.getByTestId('menu-item-new-drive').click();
  await expect(page.getByTestId('current-drive-title')).toHaveText('My drive', {
    timeout: 30_000,
  });
  // A one-time hint points at the switcher, and closes on its X.
  const hint = page.getByTestId('ui-hint-drive-switcher');
  await expect(hint).toBeVisible({ timeout: 30_000 });
  await expect(hint).toHaveText('Switch back to your previous drive here');
  await page.getByTestId('ui-hint-close').click();
  await expect(hint).toHaveCount(0);

  await expect(panels).toHaveCount(1, { timeout: 30_000 });
  await expect(panels).toBeVisible();
  // Give a stale panel the time it would need to linger.
  await page.waitForTimeout(2000);
  await expect(panels).toHaveCount(1);
});

test('Name your drive renames the drive, not the document on screen', async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const panel = page.getByTestId('getting-started');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');

  await page.locator('[data-sidebar-id]', { hasText: 'Start here' }).click();
  await expect(editableTitle(page)).toHaveText('Start here', {
    timeout: 30_000,
  });

  // The step goes to the drive's page and points at its title.
  await panel.getByRole('button', { name: 'Name your drive' }).click();
  const hint = page.getByTestId('ui-hint-drive-title');
  await expect(hint).toBeVisible({ timeout: 15_000 });
  await expect(hint).toHaveText('Click to name your drive');
  await expect(editableTitle(page)).toHaveText('Welcome to Atomic');
  await editableTitle(page).click();
  await expect(hint).toHaveCount(0);
  await expect(editableTitle(page)).toHaveRole('textbox', { timeout: 15_000 });
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+a' : 'Control+a',
  );
  await page.keyboard.type('Garden Club');
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('current-drive-title')).toHaveText(
    'Garden Club',
    { timeout: 30_000 },
  );
  await page.locator('[data-sidebar-id]', { hasText: 'Start here' }).click();
  await expect(editableTitle(page)).toHaveText('Start here', {
    timeout: 30_000,
  });
});

test('Make something points at the New row, and the X or Escape closes it', async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const panel = page.getByTestId('getting-started');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');

  const step = panel.getByRole('button', { name: 'Make something' });
  const hint = page.getByTestId('ui-hint-new-row');

  // Hovering shows the hint itself, and moving off hides it again.
  await step.hover();
  await expect(hint).toHaveText('Make a document or table here');
  await page.mouse.move(600, 400);
  await expect(hint).toHaveCount(0);

  // A click keeps it, also once the pointer leaves.
  await step.click();
  await page.mouse.move(600, 400);
  await expect(hint).toHaveText('Make a document or table here');
  await page.getByTestId('ui-hint-close').click();
  await expect(hint).toHaveCount(0);

  await step.click();
  await expect(hint).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hint).toHaveCount(0);
});

test('Read Start here points at the Start here row and ticks once it is opened', async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const panel = page.getByTestId('getting-started');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');

  const step = panel.getByRole('button', { name: 'Read Start here' });
  await expect(step).toHaveAttribute('data-done', 'false');

  await step.click();
  const hint = page.getByTestId('ui-hint-start-here');
  await expect(hint).toHaveText('Open Start here');

  // Using the row the hint points at opens the document and closes the hint.
  await page.locator('[data-sidebar-id]').first().click();
  await expect(hint).toHaveCount(0);
  await expect(step).toHaveAttribute('data-done', 'true');
});

test('The Getting started list is on the drive page of a phone, with the sidebar closed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const list = page.getByTestId('getting-started-page');
  await expect(list).toBeVisible({ timeout: 60_000 });
  await expect(list).toContainText('0 of 6');

  // Sidebar closed: the page's own list is the way in.
  // (it only peeks out as a thin edge).
  const sidebarRight = async () =>
    (await page.getByTestId('sidebar').boundingBox())!.x +
    (await page.getByTestId('sidebar').boundingBox())!.width;

  await expect.poll(sidebarRight).toBeLessThan(24);

  // A step about the page shows its hint right there.
  await list.getByRole('button', { name: 'Name your drive' }).click();
  await expect(page.getByTestId('ui-hint-drive-title')).toHaveText(
    'Click to name your drive',
  );
  await page.keyboard.press('Escape');

  // A step about the sidebar opens it first, then shows the hint.
  await list.getByRole('button', { name: 'Make something' }).click();
  await expect(page.getByTestId('ui-hint-new-row')).toHaveText(
    'Make a document or table here',
  );
  await expect.poll(sidebarRight).toBeGreaterThan(150);
});

test('Copying an invite link ticks the Invite step, with no account portal', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const panel = page.getByTestId('getting-started');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect(panel).toContainText('0 of 6');

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // First share: the dialog asks who you are before it shows the invite UI.
  await dialog.getByLabel('Full name').fill('Test Person');
  await dialog.getByLabel('Full name').press('Enter');
  await dialog.getByRole('button', { name: 'Copy invite link' }).click();
  await expect(page.getByText('Invite link copied')).toBeVisible({
    timeout: 30_000,
  });

  // The link is listed as an invite, without an address, and the step ticks.
  const row = dialog.locator('[data-test="share-invited"]');
  await expect(row).toContainText('Invite link');
  await expect(row).toContainText('Copied');
  await page.keyboard.press('Escape');
  await expect(panel).toContainText('1 of 6', { timeout: 30_000 });

  // Derived from the record, so it survives a reload and shows in the list.
  await page.reload();
  await expect(panel).toContainText('1 of 6', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(
    page.getByRole('dialog').locator('[data-test="share-invited"]'),
  ).toContainText('Invite link', { timeout: 30_000 });
});

test('A denied clipboard still records the invite link and ticks the step', async ({
  page,
}) => {
  // Safari and embedded browsers reject writeText.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () => Promise.reject(new Error('NotAllowedError')),
      },
      configurable: true,
    });
  });
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const panel = page.getByTestId('getting-started');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect(panel).toContainText('0 of 6');

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill('Test Person');
  await dialog.getByLabel('Full name').press('Enter');
  await dialog.getByRole('button', { name: 'Copy invite link' }).click();
  await expect(
    page.getByText('Could not copy the link. Select it and copy it by hand.'),
  ).toBeVisible({ timeout: 30_000 });

  const row = dialog.locator('[data-test="share-invited"]');
  await expect(row).toContainText('Invite link', { timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(panel).toContainText('1 of 6', { timeout: 30_000 });
});
