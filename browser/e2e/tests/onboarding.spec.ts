import { test, expect, Browser } from '@playwright/test';
import { FRONTEND_URL, SERVER_URL } from './test-utils';

test.describe('onboarding', () => {
  test('create new identity with verifySecret flow - profile name persists', async ({
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

    // Verify the secret contains the drive URL and agent subject by decoding it
    const decodedSecret = JSON.parse(atob(secret!));
    expect(decodedSecret.initialDrive).toBeTruthy();
    expect(decodedSecret.initialDrive).toContain('did:ad:');
    expect(decodedSecret.subject).toBeTruthy();
    expect(decodedSecret.subject).toContain('did:ad:agent:');

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

    // Wait for auto-verify to trigger
    await page.waitForTimeout(500);

    // Should auto-verify and navigate to the drive
    await expect(page).toHaveURL(/did(?:%3A|:)ad(?:%3A|:)/, { timeout: 10000 });

    // Open a NEW BROWSER CONTEXT (fresh, as if on a completely different computer)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    // Sign in with the secret on the SettingsAgent page (same flow as LoggedOutAgentPanel)
    await page2.goto(`${FRONTEND_URL}/app/agent`);
    await page2.getByLabel('Enter your Agent Secret').fill(secret!);
    await page2.getByRole('button', { name: 'Sign in' }).click();

    // Wait for "User Settings" heading which indicates successful sign-in
    await expect(
      page2.getByRole('heading', { name: 'User Settings' }),
    ).toBeVisible({ timeout: 10000 });

    // Navigate to the agent's profile edit page to verify the name was saved
    // Use the subject from the decoded secret directly
    await page2.goto(`${FRONTEND_URL}/${decodedSecret.subject}/edit`);

    // The profile name "Test User" should be visible somewhere on the page
    // This verifies that the profile name was actually persisted to the server
    await expect(page2.getByText('Test User')).toBeVisible({ timeout: 5000 });

    // Verify the drive is stored in the agent's drives array on the server
    const agentUrl = `${SERVER_URL}/${decodedSecret.subject}`;
    const agentResponse = await page2.evaluate(
      async ({ url, initialDrive }) => {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
        });
        const data = await response.json();
        return {
          drives: data['https://atomicdata.dev/server/properties/drives'] || [],
          initialDrive,
        };
      },
      {
        url: agentUrl,
        initialDrive: decodedSecret.initialDrive,
      },
    );

    expect(agentResponse.drives).toContain(agentResponse.initialDrive);
    expect(agentResponse.drives.length).toBeGreaterThanOrEqual(1);

    await context2.close();
  });
});
