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
    'Save your work',
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

  // Not linked to an account: the sidebar says so, with the next step.
  const row = page.getByTestId('guest-save-row');
  await expect(row).toContainText('Only saved on this device');
  // Self-hosted, with no portal: nothing here asks for an email.
  await expect(row).toContainText('Connect a device');

  // The panel's Save your work row does not open anything: it points at the
  // row where it is done, until the X closes it.
  const drive = page.url();
  await panel
    .getByRole('button', { name: 'Save your work', exact: true })
    .click();
  const hint = page.getByTestId('ui-hint-save-row');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('Connect a device here');
  await page.getByTestId('ui-hint-close').click();
  await expect(hint).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Using the thing the hint points at opens the dialog and leaves the page where it is.
  await panel
    .getByRole('button', { name: 'Save your work', exact: true })
    .click();
  await expect(hint).toBeVisible();
  await row.click();
  await expect(hint).toHaveCount(0);
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Save your work' }),
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
