import { test, expect } from './fixtures';
import { FRONTEND_URL } from './test-utils';

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

  // They land on the page of the ready-made drive: the Getting started card
  // on top, the Welcome document as its first row.
  await expect(page.getByTestId('current-drive-title')).toHaveText(
    'Welcome to Atomic',
  );
  const card = page.getByTestId('getting-started');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('Getting started');
  await expect(card).toContainText('0 of 5');

  for (const step of [
    'Name your drive',
    'Start a project',
    'Talk to the AI',
    'Invite someone',
    'Save your work',
  ]) {
    await expect(card.getByText(step, { exact: true })).toBeVisible();
  }

  // Inviting needs a project first, and says so.
  await expect(card.getByRole('button', { name: 'Invite' })).toBeDisabled();
  await expect(card).toContainText('Start a project first');
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

test('Hide removes the Getting started card and it stays away after a reload', async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Get started' }).click();
  const card = page.getByTestId('getting-started');
  await expect(card).toBeVisible({ timeout: 60_000 });

  // A new drive opens with its title in edit mode, and the first click would
  // only end that.
  await page.keyboard.press('Escape');
  await card.getByRole('button', { name: 'Hide' }).click();
  await expect(card).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('current-drive-title')).toHaveText(
    'Welcome to Atomic',
    { timeout: 30_000 },
  );
  await expect(card).toHaveCount(0);
});
