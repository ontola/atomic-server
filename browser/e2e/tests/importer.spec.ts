import { test, expect } from './fixtures';
import { before, FRONTEND_URL, getCurrentSubject, smoke } from './test-utils';

const recipe = `<!doctype html><html><head><title>Pannenkoeken</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Recipe","name":"Pannenkoeken",
 "description":"Dunne Hollandse pannenkoeken.","prepTime":"PT10M",
 "recipeIngredient":["250 g bloem","500 ml melk"]}
</script></head><body></body></html>`;

test.describe('importer', () => {
  test.beforeEach(before);

  test(
    'pastes a page, saves it once and offers an update the second time',
    smoke,
    async ({ page }) => {
      const drive = await getCurrentSubject(page);

      const open = async () => {
        await page.goto(
          `${FRONTEND_URL}/app/import?subject=${encodeURIComponent(drive)}`,
        );
        await page
          .getByLabel('Web address')
          .fill('https://example.test/pannenkoeken');
        await page.getByLabel('Text or page source').fill(recipe);
        await page.locator('[data-test="import-analyse"]').click();
        await expect(page.locator('[data-test="import-summary"]')).toHaveText(
          'Found Recipe data on the page.',
        );
      };

      await open();
      await expect(
        page.locator('[data-test="import-proposal"]'),
      ).not.toContainText('imported before');
      await expect(page.getByLabel(/^name/i)).toHaveValue('Pannenkoeken');

      // Nothing exists yet; Save creates the Bookmark and opens it.
      await page.locator('[data-test="save"]').click();
      await expect(page.getByText('Prep time: 10 min')).toBeVisible();

      await open();
      await expect(page.locator('[data-test="import-proposal"]')).toContainText(
        'imported before',
      );
    },
  );
});
