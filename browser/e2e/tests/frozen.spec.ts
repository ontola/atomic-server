import { expect, test } from '@playwright/test';
import { before, contextMenuClick, openSubject } from './test-utils';

/**
 * The frozen (`did:ad:frozen`) feature, end to end through the data-browser:
 *  1. Freeze a resource into immutable, content-addressed JSON-AD.
 *  2. Publish it to the server and resolve it back by its frozen id.
 *  3. A frozen resource is immutable — no edit affordance.
 */
test.describe('freeze', () => {
  test.beforeEach(before);

  test('freezes a resource, publishes it, and resolves the frozen copy', async ({
    page,
  }) => {
    // The current resource is the dev drive. Freeze it.
    await contextMenuClick('freeze', page);

    const dialog = page.locator('dialog[open]');
    await expect(
      dialog.getByRole('heading', { name: /^Freeze/ }),
    ).toBeVisible();

    // The frozen JSON-AD is content-addressed: a did:ad:frozen id appears.
    const body = dialog.locator('pre');
    await expect(body).toContainText(/did:ad:frozen:[0-9a-f]{64}/, {
      timeout: 15000,
    });

    const frozenId = (await body.innerText()).match(
      /did:ad:frozen:[0-9a-f]{64}/,
    )?.[0];
    expect(frozenId).toBeTruthy();

    // Publish to the server, then resolve the frozen resource by its id.
    await dialog.getByRole('button', { name: 'Publish to server' }).click();
    await expect(
      page.getByText(/Published \d+ frozen resource/),
    ).toBeVisible({ timeout: 15000 });

    await openSubject(page, frozenId!);
    await expect(
      page.locator(`main[about="${frozenId}"]`).first(),
    ).toBeVisible({ timeout: 20000 });

    // A frozen resource is immutable: the context menu offers no Edit.
    await page.click('[data-test="context-menu"]');
    await expect(page.getByTestId('menu-item-edit')).toHaveCount(0);
  });
});
