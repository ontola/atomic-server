import { test, expect, type Page } from './fixtures';
import { before } from './test-utils';

async function expectLeftSidebarClosed(page: Page) {
  const sidebar = page.getByTestId('sidebar');

  await expect
    .poll(async () =>
      sidebar.evaluate(
        element => element.parentElement!.getBoundingClientRect().width,
      ),
    )
    .toBe(0);
  await expect
    .poll(() =>
      sidebar.evaluate(element => Number(getComputedStyle(element).opacity)),
    )
    .toBe(0);
}

for (const [name, trigger, panel] of [
  ['AI chat', 'navbar-ai-button', 'ai-sidebar'],
  ['comments', 'navbar-comments-button', 'comments-panel'],
] as const) {
  test(`opening ${name} closes the left sidebar at tablet width`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 828, height: 1160 });
    await before({ page });
    const sidebar = page.getByTestId('sidebar');
    await expect
      .poll(() =>
        sidebar.evaluate(
          element => element.parentElement!.getBoundingClientRect().width,
        ),
      )
      .toBeGreaterThan(0);
    await page.mouse.move(700, 400);
    await page.getByTestId(trigger).click();
    await expect(page.getByTestId(panel)).toHaveAttribute('data-open', '');
    await expectLeftSidebarClosed(page);
    await page.mouse.move(2, 400);
    await expect
      .poll(() =>
        sidebar.evaluate(element => Number(getComputedStyle(element).opacity)),
      )
      .toBe(0);
  });
}

test('opening meeting chat closes the left sidebar at tablet width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 828, height: 1160 });
  await before({ page });
  await expect
    .poll(() =>
      page
        .getByTestId('sidebar')
        .evaluate(
          element => element.parentElement!.getBoundingClientRect().width,
        ),
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'New Meeting' }).first().click();
  await page.getByRole('button', { name: 'Open chat', exact: true }).click();
  await expect(page.getByTestId('follow-session-panel')).toHaveAttribute(
    'data-open',
    '',
  );
  await expectLeftSidebarClosed(page);
});

for (const panel of ['followSession', 'comments', 'ai']) {
  test(`does not restore stale ${panel} panel from another session`, async ({
    page,
  }) => {
    await before({ page });
    await page.evaluate(
      value =>
        localStorage.setItem('atomic.rightPanel.active', JSON.stringify(value)),
      panel,
    );
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'More', exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-testid="follow-session-panel"][data-open], [data-testid="comments-panel"][data-open], [data-testid="ai-sidebar"][data-open]',
      ),
    ).toHaveCount(0);
  });
}

test('comments close when navigating to a page without a resource', async ({
  page,
}) => {
  await before({ page });
  await page.getByTestId('navbar-comments-button').click();
  await expect(page.getByTestId('comments-panel')).toHaveAttribute(
    'data-open',
    '',
  );
  await page.getByRole('link', { name: /Sync$/ }).click();
  await expect(page.getByTestId('comments-panel')).not.toHaveAttribute(
    'data-open',
    '',
  );
  await page.goBack();
  await expect(page.getByTestId('navbar-comments-button')).toBeVisible();
  await expect(page.getByTestId('comments-panel')).not.toHaveAttribute(
    'data-open',
    '',
  );
});

test('deleting an explicitly opened meeting closes its panel', async ({
  page,
}) => {
  await before({ page });
  await page.getByRole('button', { name: 'New Meeting' }).first().click();
  await page.getByRole('button', { name: 'Open chat', exact: true }).click();
  await expect(page.getByTestId('follow-session-panel')).toHaveAttribute(
    'data-open',
    '',
  );
  await page.evaluate(async () => {
    const subject = new URL(location.href).searchParams.get('subject')!;
    await window.store.getResourceLoading(subject).destroy();
  });
  await expect(page.getByTestId('follow-session-panel')).not.toHaveAttribute(
    'data-open',
    '',
  );
});

test('switching drives closes a panel without resurrecting it on return', async ({
  page,
}) => {
  await before({ page });
  const original = await page.evaluate(() => window.store.getDrive());
  // The last assertion is about returning to this drive, so it is vacuous if
  // there was never one to return to.
  expect(original).toBeTruthy();
  await page.getByTestId('navbar-comments-button').click();
  await expect(page.getByTestId('comments-panel')).toHaveAttribute(
    'data-open',
    '',
  );
  await page.evaluate(async () => {
    const drive = await window.store.createDrive('Second panel test drive', {
      personal: false,
    });
    window.store.setDrive(drive.subject);
  });
  await expect(page.getByTestId('comments-panel')).not.toHaveAttribute(
    'data-open',
    '',
  );
  await page.evaluate(drive => window.store.setDrive(drive), original!);
  await expect(page.getByTestId('comments-panel')).not.toHaveAttribute(
    'data-open',
    '',
  );
});
