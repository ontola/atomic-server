import { test, expect, Browser } from '@playwright/test';
import { FRONTEND_URL } from './test-utils';

test.describe('onboarding', () => {
  test('create new identity with verifySecret flow', async ({
    page,
    browser,
  }) => {
    // Navigate to user settings
    await page.goto(`${FRONTEND_URL}/app/agent`);

    // Click "Create new identity"
    await page.getByRole('button', { name: 'Create new identity' }).click();

    // Wait for the profile step (after identity is created)
    await expect(
      page.getByRole('heading', { name: "You're signed in!" }),
    ).toBeVisible({ timeout: 10000 });

    // Set a profile name
    await page.getByLabel('Profile Name').fill('Test User');

    // Click Save & Next
    await page.getByRole('button', { name: 'Save & Next' }).click();

    // Should be on the drive creation step with personalized heading
    await expect(
      page.getByRole('heading', { name: /Test User, create your Drive/ }),
    ).toBeVisible();

    // Create a drive
    await page.getByLabel('Drive Name').fill('My Test Drive');
    await page.getByRole('button', { name: 'Create Drive' }).click();

    // NOW we should see the secret step - the secret includes the drive URL
    await expect(
      page.getByRole('heading', { name: 'Your new identity is ready' }),
    ).toBeVisible({ timeout: 10000 });

    // Get the secret from the code block BEFORE signing out
    const secret = await page
      .locator('[data-code-content]')
      .getAttribute('data-code-content');

    expect(secret).toBeTruthy();
    expect(secret).toContain('eyJ'); // Base64 encoded JSON

    // Verify the secret contains the drive URL by decoding it
    const decodedSecret = JSON.parse(atob(secret!));
    expect(decodedSecret.initialDrive).toBeTruthy();
    expect(decodedSecret.initialDrive).toContain('did:ad:');

    // Click confirm to sign out and go to verify
    await page.locator('button[title="Copy to clipboard"]').click();
    await expect(
      page.getByRole('button', { name: /Yes, I.*stored it.*sign me out/ }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: /Yes, I.*stored it.*sign me out/ })
      .click();

    // Should now be on the verify step
    await expect(
      page.getByRole('heading', { name: 'Verify your secret' }),
    ).toBeVisible();

    // Paste the secret we read earlier (clipboard may not work after signout)
    await page.getByLabel('Enter your Agent Secret').fill(secret!);

    // Should auto-verify and be done - navigate to the drive
    await expect(page.getByText('My Test Drive')).toBeVisible({
      timeout: 10000,
    });

    // Open a NEW BROWSER CONTEXT (fresh, as if on a completely different computer)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto(`${FRONTEND_URL}/app/agent`);

    // Sign in with the secret
    await page2.getByLabel('Enter your Agent Secret').fill(secret!);

    // Should auto-verify and be done - navigate to the drive
    await expect(page2.getByText('My Test Drive')).toBeVisible({
      timeout: 10000,
    });

    await context2.close();
  });
});
