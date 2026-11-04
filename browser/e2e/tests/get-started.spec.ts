import { test, expect } from './fixtures';
import {
  FRONTEND_URL,
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
  await expect(panel).toContainText('0 of 5');

  for (const step of [
    'Name your drive',
    'Start a drive',
    'Talk to the AI',
    'Invite someone',
    'Save your work',
  ]) {
    await expect(panel.getByText(step, { exact: true })).toBeVisible();
  }

  // Inviting needs a drive first, and says so.
  const invite = panel.getByRole('button', { name: 'Invite someone' });
  await expect(invite).toBeDisabled();
  await expect(invite).toHaveAttribute('title', 'Start a drive first');
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
  await expect(panel).toContainText('0 of 5');

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
  await expect(row).toContainText('Saved on this device');
  // Self-hosted, with no portal: nothing here asks for an email.
  await expect(row.getByRole('button')).toHaveText('Connect a device');

  // The panel's Save your work row opens the dialog and leaves the page where it is.
  const drive = page.url();
  await panel
    .getByRole('button', { name: 'Save your work', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Save your work' }),
  ).toBeVisible();
  await expect(dialog).toContainText('saved on this device');
  await expect(page).toHaveURL(drive);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // So does the row.
  await row.getByRole('button').click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Save your work' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
  // A one-time hint points at the switcher, and goes on any click.
  const hint = page.getByTestId('drive-switcher-hint');
  await expect(hint).toBeVisible({ timeout: 30_000 });
  await expect(hint).toHaveText('Switch back to your previous drive here');
  await page.mouse.click(700, 400);
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

  await panel.getByRole('button', { name: 'Name your drive' }).click();
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
