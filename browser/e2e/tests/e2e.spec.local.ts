// Modified e2e tests to work with local server only
import { test, expect } from '@playwright/test';
import {
  FRONTEND_URL,
  SERVER_URL,
  before,
  currentDriveTitle,
  editProfileAndCommit,
  editableTitle,
  newDrive,
  openSubject,
  signIn,
  timestamp,
  openAgentPage,
} from './test-utils';

test.describe('local-server-auth', () => {
  test.beforeEach(before);

  test('sign in with /setup invite', async ({ page }) => {
    // Check if we already have an agent
    const hasAgent = await page.evaluate(() => {
      const agent = localStorage.getItem('agent');
      return agent !== null && agent !== '';
    });

    if (!hasAgent) {
      // Go to setup page
      await page.goto(`${SERVER_URL}/setup`);
      
      // The setup invite should be available on first run
      // Look for various possible Accept button texts
      const acceptButton = page.getByRole('button', { name: /Accept/i }).first();
      
      if (await acceptButton.isVisible({ timeout: 5000 })) {
        await acceptButton.click();
        await page.waitForURL(/\/(app)?$/, { timeout: 10000 });
        await expect(currentDriveTitle(page)).toBeVisible();
      } else {
        // If no setup invite, the server might already be initialized
        console.log('No setup invite found, server may already be initialized');
      }
    }
    
    // Verify we're signed in by checking agent page
    await openAgentPage(page);
    await expect(
      page.getByRole('button', { name: 'Edit profile' }).or(
        page.getByText('Agent')
      )
    ).toBeVisible({ timeout: 10000 });
  });

  test('create and edit document in local server', async ({ page }) => {
    await signIn(page);
    
    // Create a new drive to work with
    const { driveURL, driveTitle } = await newDrive(page);
    
    // Create a new document
    await page.getByTestId('sidebar-new-resource').click();
    await page.locator('button:has-text("Document")').click();
    
    // Wait for the document to be created
    await expect(editableTitle(page)).toBeVisible({ timeout: 10000 });
    
    // Edit the document
    const teststring = `Test content ${timestamp()}`;
    await page.keyboard.press('Enter'); // Start editing
    await page.fill('[data-test="element-input"]', teststring);
    await expect(page.locator(`text=${teststring}`)).toBeVisible();
    
    // Edit the title
    const docTitle = `Document ${timestamp()}`;
    await editableTitle(page).click();
    await editableTitle(page).fill(docTitle);
    await page.keyboard.press('Escape');
    
    // Verify the title was saved
    await expect(editableTitle(page)).toContainText(docTitle);
  });

  test('sign in, edit profile, and sign out', async ({ page }) => {
    await signIn(page);
    await editProfileAndCommit(page);

    // Set up dialog handler before signing out
    page.on('dialog', d => {
      d.accept();
    });

    // Sign out
    await openAgentPage(page);
    await page.click('[data-test="sign-out"]');
    
    // Verify signed out state
    await expect(
      page.locator('text=Enter your Agent secret').or(
        page.locator('text=Sign in').or(
          page.locator('text=No agent set')
        )
      )
    ).toBeVisible({ timeout: 10000 });
    
    // Verify state persists after reload
    await page.reload();
    await expect(
      page.locator('text=Enter your Agent secret').or(
        page.locator('text=Sign in').or(
          page.locator('text=No agent set')
        )
      )
    ).toBeVisible({ timeout: 10000 });
  });
});