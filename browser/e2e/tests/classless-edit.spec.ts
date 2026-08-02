import { test, expect, type Page } from '@playwright/test';
import { before, FRONTEND_URL } from './test-utils';

const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';

/**
 * Creates a resource with no `isA` (and therefore no Class), saves it, and
 * returns its subject. Used to exercise the classless edit form path.
 */
async function createClasslessResource(page: Page): Promise<string> {
  await page.waitForFunction(
    () =>
      window.store.getClientDb()?.isReady === true &&
      window.store.getSyncStatus().serverConnected === true,
    undefined,
    { timeout: 30_000 },
  );

  return page.evaluate(async props => {
    const store = window.store;
    const drive = store.getDrive();
    const resource = await store.newResource({
      parent: drive,
      propVals: {
        [props.name]: 'Classless Thing',
        [props.description]: 'No class, still editable',
      },
    });
    await resource.save();

    return resource.subject;
  }, { name: NAME, description: DESCRIPTION });
}

test.describe('classless resource edit', () => {
  test.beforeEach(before);

  test('edit form renders existing properties without a Class', async ({
    page,
  }) => {
    const subject = await createClasslessResource(page);

    await page.goto(
      `${FRONTEND_URL}/app/edit?subject=${encodeURIComponent(subject)}`,
    );

    await expect(page.getByRole('heading', { name: /Edit/ })).toBeVisible({
      timeout: 15_000,
    });

    // The old hard gate must not appear.
    await expect(
      page.getByText(/is not a Class\. Only resources with valid classes/),
    ).toHaveCount(0);

    // Existing properties are editable (ResourceField uses shortname test ids).
    await expect(page.getByTestId('input-name')).toBeVisible();
    await expect(page.getByTestId('input-description')).toBeVisible();

    // Advanced still offers adding another property.
    await page.getByRole('button', { name: /Advanced/ }).click();
    await expect(page.getByText('Add another property...')).toBeVisible();

    // Save stays available (form is valid with the existing fields).
    await expect(page.getByTestId('save')).toBeEnabled();
  });
});
