import { test, expect } from '@playwright/test';
import { before, newDrive, newResource, signIn } from './test-utils';

test.describe('JSON prop', () => {
  test.beforeEach(before);

  test('create JSON prop', async ({ page }) => {
    await signIn(page);
    await newDrive(page);

    // A class with a JSON prop, made for this test.
    await newResource(
      'https://atomicdata.dev/01k10mtpp8fkkmsd6tkm9qrqyw/defaultontology/class/test-class-with-json-prop',
      page,
    );

    await expect(
      page.getByRole('heading', { name: 'new test-class-with-json-prop' }),
    ).toBeVisible();

    const name = `Instance: ${Date.now()}`;
    await page.getByLabel('Name').fill(name);

    const jsonEditor = page.getByLabel('Test-Json-Prop');
    await jsonEditor.fill('{"valid": false,}');

    const saveButton = page.getByRole('button', { name: 'Save' });
    await expect(saveButton).toBeDisabled();

    await jsonEditor.fill('{"valid": true}');
    await expect(saveButton).not.toBeDisabled();

    await saveButton.click();

    // After save, EditableTitle auto-enters edit mode (renders as a textbox);
    // match either the input or the h1 form via the test-id.
    await expect(
      page
        .getByTestId('editable-title')
        .and(page.locator(`:text-is("${name}"), [value="${name}"]`))
        .first(),
    ).toBeVisible();

    await expect(page.getByText('{\n  "valid": true\n  }')).toHaveRole('code');
  });
});
