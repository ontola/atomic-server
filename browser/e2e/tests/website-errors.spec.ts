import { test, expect } from '@playwright/test';
import { before, waitForSynced } from './test-utils';

test('unreadable website content reports an error, stops loading and recovers', async ({
  page,
}) => {
  await before({ page });
  const errors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const subject = await page.evaluate(async () => {
    const { createWebsite, starterWebsite } = window.atomicE2E.websiteModel;
    const store = window.store;
    const config = starterWebsite('Preview error recovery');
    config.pages[0].media = [
      {
        subject: `${store.getServerUrl()}/missing-website-image`,
        alt: 'Missing photo',
      },
    ];

    return (await createWebsite(store, store.getDrive()!, config)).subject;
  });
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(subject)}`,
  );
  await expect(
    page.getByText(
      'Publishing is unavailable until the draft preview can be built. Check access to the selected content, then retry.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Preparing preview…')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Publish site', exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => errors.some(error => error.includes('Website preview failed:')))
    .toBe(true);
  await expect(
    page
      .locator('[role="status"]')
      .filter({ hasText: 'Website preview failed:' })
      .first(),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry preview', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Retry preview', exact: true }),
  ).toBeVisible();
  await page.evaluate(async site => {
    const { readWebsite, updateWebsite } = window.atomicE2E.websiteModel;
    const store = window.store;
    const resource = await store.getResource(site);
    const { config } = await readWebsite(store, store.getDrive()!, resource);
    config.pages[0].media = [];
    await updateWebsite(store, store.getDrive()!, resource, config);
  }, subject);
  await expect(
    page.getByRole('button', { name: 'Publish site', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Retry preview', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .frameLocator('iframe[title="Website preview"]')
      .getByRole('heading', { name: 'Preview error recovery' })
      .first(),
  ).toBeVisible();
  expect(errors.filter(error => error.includes('unique "key"'))).toEqual([]);
});

test('hosting status failures are logged and clear after reconnecting', async ({
  page,
}) => {
  await before({ page });
  const errors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/website-hosting?*', route =>
    route.fulfill({ status: 503, body: 'Hosting temporarily unavailable' }),
  );
  const subject = await page.evaluate(async () => {
    const { createWebsite, starterWebsite } = window.atomicE2E.websiteModel;
    const store = window.store;

    return (
      await createWebsite(
        store,
        store.getDrive()!,
        starterWebsite('Hosting recovery'),
      )
    ).subject;
  });
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(subject)}`,
  );
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Could not load website hosting status:' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      errors.some(error =>
        error.includes('Could not load website hosting status:'),
      ),
    )
    .toBe(true);
  await page.unroute('**/website-hosting?*');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Could not load website hosting status:' }),
  ).toHaveCount(0);
});

/**
 * The failure above is permanent: the image really is missing. This one is not,
 * and the page used to treat the two the same. `store.getResource` gives up
 * after its own 10s settle timeout, which a loaded machine reaches, and one
 * such read left the website unpublishable for as long as the tab stayed open:
 * `problem` disables Prepare release, Page edit and Publish site, and nothing
 * asked again, because the subscription that would has to make the same read to
 * register itself.
 */
test('a preview that failed on a slow read comes back without being asked', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await before({ page });
  await page
    .getByRole('button', { name: 'New Document', exact: true })
    .first()
    .click();
  await page.locator('#document-editor').fill('Sow spinach in September.');
  await waitForSynced(page);
  const documentSubject = new URL(page.url()).searchParams.get('subject')!;
  const site = await page.evaluate(async document => {
    const { createWebsite, starterWebsite } = window.atomicE2E.websiteModel;
    const store = window.store;
    const config = starterWebsite('Recovery bakery');
    config.pages[0].documents = [document];

    return (await createWebsite(store, store.getDrive()!, config)).subject;
  }, documentSubject);

  // Fail ONE subject rather than every read, so the app still boots and this
  // test measures the website page rather than the whole client. The message is
  // the one the store itself raises, so a reader of a failing run recognises it.
  await page.addInitScript(
    ({ subject, ms }: { subject: string; ms: number }) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const store = window.store as unknown as {
          patchedForTest?: boolean;
          getResource: (s: string, ...rest: unknown[]) => Promise<unknown>;
        };

        if (!store || store.patchedForTest) return;

        store.patchedForTest = true;
        clearInterval(timer);
        const read = store.getResource.bind(store);

        store.getResource = async (s: string, ...rest: unknown[]) => {
          if (s === subject && Date.now() - start < ms) {
            throw new Error(
              `Async Request for subject "${s}" timed out after 10000ms.`,
            );
          }

          return read(s, ...rest);
        };
      }, 5);
    },
    { subject: documentSubject, ms: 8000 },
  );

  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(site)}`,
  );
  // Asserted first, so a patch that stopped biting fails this test instead of
  // passing it for nothing.
  await expect(
    page.getByText('Publishing is unavailable until the draft preview'),
  ).toBeVisible({ timeout: 30_000 });
  // And the point: nobody clicks Retry preview. Measured at 5.9s here, against
  // the whole 45s with the retry removed.
  await expect(
    page.getByRole('button', { name: 'Publish site', exact: true }),
  ).toBeEnabled({ timeout: 45_000 });
  await expect(
    page.getByRole('button', { name: 'Retry preview', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .frameLocator('iframe[title="Website preview"]')
      .getByText('Sow spinach in September.'),
  ).toBeVisible({ timeout: 30_000 });
});
