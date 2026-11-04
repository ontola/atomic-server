import { test, expect } from '@playwright/test';
import { installEmptyDiscoveryRoom } from './fixtures';
import { devDrive, FRONTEND_URL, sideBarDriveSwitcher } from './test-utils';

test.beforeEach(async ({ context }) => {
  await installEmptyDiscoveryRoom(context);
});

test('a new drive is made without asking and opens empty, with ways to start', async ({
  page,
}) => {
  test.setTimeout(120000);
  await devDrive(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${FRONTEND_URL}/app/new-drive`);

  // No form: the drive is made on load, and no gallery or preview is offered.
  await expect(page).not.toHaveURL(/new-drive/, { timeout: 60000 });
  await expect(page.getByLabel('Drive name')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Preview template' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Include example content')).toHaveCount(0);

  // The drive is empty, and says what can go in it.
  await expect(page.getByTestId('current-drive-title')).toHaveText('My drive', {
    timeout: 30000,
  });
  const start = page.getByLabel('Start this drive');
  await expect(start).toBeVisible({ timeout: 30000 });

  for (const label of ['Document', 'Table', 'Canvas']) {
    await expect(start.getByRole('button', { name: label })).toBeVisible();
  }

  for (const title of ['Student', 'Team', 'Personal']) {
    await expect(start.getByText(new RegExp(`\\s${title}$`))).toBeVisible();
  }

  await expect(start.getByText('Welcome to Atomic')).toHaveCount(0);
});

test('a starter fills the empty drive it is chosen in, with checklists', async ({
  page,
}) => {
  test.setTimeout(120000);
  await devDrive(page);
  await page.goto(`${FRONTEND_URL}/app/new-drive`);
  await expect(page).not.toHaveURL(/new-drive/, { timeout: 60000 });
  const drive = await page.evaluate(() => window.store.getDrive()!);

  const start = page.getByLabel('Start this drive');
  await expect(start).toBeVisible({ timeout: 30000 });
  // A new drive opens with its title in edit mode. Leave it first: its blur
  // reflows the header, and a click that starts during that reflow is lost.
  await page.mouse.click(1100, 400);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .not.toBe('TEXTAREA');
  await start
    .getByRole('button', { name: 'Use this starter', exact: true })
    .first()
    .click();

  // The drive is no longer empty, so the block goes away.
  await expect(start).toHaveCount(0, { timeout: 60000 });
  await expect(
    page.getByRole('link', { name: 'Lecture notes' }).first(),
  ).toBeVisible();

  const result = await page.evaluate(async parent => {
    const store = window.store;
    const children = await store.queryLocalDb({
      property: 'https://atomicdata.dev/properties/parent',
      value: parent,
    });
    const names: unknown[] = [];

    for (const subject of children?.subjects ?? [])
      names.push(
        (await store.getResource(subject)).get(
          'https://atomicdata.dev/properties/name',
        ),
      );

    return { drive: store.getDrive(), names };
  }, drive);
  // It went into this drive, not a new one.
  expect(result.drive).toBe(drive);
  expect(result.names).toContain('Assignments');
  expect(result.names).toContain('Lecture notes');

  await page.getByRole('link', { name: 'Lecture notes' }).first().click();
  await expect(
    page.locator('ul[data-type="taskList"] input[type="checkbox"]'),
  ).toHaveCount(3, { timeout: 30000 });
});

test('the drive switcher makes a drive straight away, without a dialog', async ({
  page,
}) => {
  await devDrive(page);
  await sideBarDriveSwitcher(page).click();
  await page.getByTestId('menu-item-new-drive').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('current-drive-title')).toHaveText('My drive', {
    timeout: 30000,
  });
  await expect(page.getByLabel('Start this drive')).toBeVisible({
    timeout: 30000,
  });
});
