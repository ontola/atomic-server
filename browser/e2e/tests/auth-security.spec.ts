/**
 * Authentication and Security Tests
 * These tests verify that authentication, authorization, and access control work correctly
 */

import { test, expect } from '@playwright/test';
import {
  before,
  SERVER_URL,
  currentDriveTitle,
  openAgentPage,
  newDrive,
  makeDrivePublic,
  editableTitle,
  publicReadRightLocator,
  contextMenu,
  addressBar,
} from './test-utils';

test.describe('Authentication and Security', () => {
  test.beforeEach(before);

  test('create agent and verify authentication', async ({ page }) => {
    // Clear any existing authentication
    await page.evaluate(() => {
      localStorage.removeItem('agent');
      localStorage.removeItem('agentSubject');
    });
    
    await page.reload();
    
    // Navigate to setup page
    await page.goto(`${SERVER_URL}/setup`);
    
    // Wait for the setup page to load
    await expect(
      page.getByRole('button', { name: 'Accept' }).or(
        page.getByRole('button', { name: 'Accept as new user' })
      )
    ).toBeVisible({ timeout: 10000 });
    
    // Accept the invite to create a new agent
    const acceptButton = page.getByRole('button', { name: 'Accept' }).or(
      page.getByRole('button', { name: 'Accept as new user' })
    );
    await acceptButton.click();
    
    // Wait for redirect to main app
    await page.waitForURL(/\/(app)?$/, { timeout: 10000 });
    
    // Verify agent is created
    const agentData = await page.evaluate(() => {
      return {
        agent: localStorage.getItem('agent'),
        agentSubject: localStorage.getItem('agentSubject')
      };
    });
    
    expect(agentData.agent).toBeTruthy();
    expect(agentData.agentSubject).toBeTruthy();
    
    // Verify we can access the agent page
    await openAgentPage(page);
    await expect(
      page.getByRole('button', { name: 'Edit profile' }).or(
        page.getByText('Agent')
      )
    ).toBeVisible({ timeout: 10000 });
  });

  test('verify agent persistence across page reloads', async ({ page }) => {
    // First ensure we have an agent
    await page.goto(`${SERVER_URL}`);
    
    let hasAgent = await page.evaluate(() => {
      return localStorage.getItem('agent') !== null;
    });
    
    if (!hasAgent) {
      // Create agent if it doesn't exist
      await page.goto(`${SERVER_URL}/setup`);
      await page.getByRole('button', { name: 'Accept' }).click();
      await page.waitForURL(/\/(app)?$/);
    }
    
    // Get agent data before reload
    const agentBefore = await page.evaluate(() => {
      return {
        agent: localStorage.getItem('agent'),
        agentSubject: localStorage.getItem('agentSubject')
      };
    });
    
    expect(agentBefore.agent).toBeTruthy();
    
    // Reload page
    await page.reload();
    
    // Get agent data after reload
    const agentAfter = await page.evaluate(() => {
      return {
        agent: localStorage.getItem('agent'),
        agentSubject: localStorage.getItem('agentSubject')
      };
    });
    
    // Verify agent persists
    expect(agentAfter.agent).toBe(agentBefore.agent);
    expect(agentAfter.agentSubject).toBe(agentBefore.agentSubject);
    
    // Verify we're still authenticated
    await openAgentPage(page);
    await expect(
      page.getByRole('button', { name: 'Edit profile' }).or(
        page.getByText('Agent')
      )
    ).toBeVisible();
  });

  test('verify access control - private drive', async ({ page }) => {
    // Ensure we're signed in
    const hasAgent = await page.evaluate(() => {
      return localStorage.getItem('agent') !== null;
    });
    
    if (!hasAgent) {
      await page.goto(`${SERVER_URL}/setup`);
      await page.getByRole('button', { name: 'Accept' }).click();
      await page.waitForURL(/\/(app)?$/);
    }
    
    // Create a new private drive
    const { driveURL } = await newDrive(page);
    
    // Verify the drive is private by default
    await currentDriveTitle(page).click();
    await page.click(contextMenu);
    await page.getByRole('menuitem', { name: 'Permissions & Invites' }).click();
    
    // Check that public read is NOT checked
    await expect(publicReadRightLocator(page)).not.toBeChecked();
    
    // Close the dialog
    await page.keyboard.press('Escape');
    
    // Get the current agent subject
    const agentSubject = await page.evaluate(() => {
      return localStorage.getItem('agentSubject');
    });
    
    // Clear authentication
    await page.evaluate(() => {
      localStorage.removeItem('agent');
      localStorage.removeItem('agentSubject');
    });
    
    // Try to access the private drive without authentication
    await page.goto(driveURL);
    
    // Should see an error or be redirected
    await expect(
      page.getByText(/unauthorized|forbidden|not allowed|sign in/i).first()
    ).toBeVisible({ timeout: 10000 });
  });

  test('verify access control - public drive', async ({ page }) => {
    // Ensure we're signed in
    const hasAgent = await page.evaluate(() => {
      return localStorage.getItem('agent') !== null;
    });
    
    if (!hasAgent) {
      await page.goto(`${SERVER_URL}/setup`);
      await page.getByRole('button', { name: 'Accept' }).click();
      await page.waitForURL(/\/(app)?$/);
    }
    
    // Create a new drive and make it public
    const { driveURL, driveTitle } = await newDrive(page);
    await makeDrivePublic(page);
    
    // Clear authentication
    await page.evaluate(() => {
      localStorage.removeItem('agent');
      localStorage.removeItem('agentSubject');
    });
    
    // Try to access the public drive without authentication
    await page.goto(driveURL);
    
    // Should be able to see the drive content
    await expect(currentDriveTitle(page)).toHaveText(driveTitle);
    
    // But should not be able to edit
    await editableTitle(page).click();
    
    // Check if the title becomes editable (it shouldn't for unauthenticated users)
    const isEditable = await editableTitle(page).isEditable();
    expect(isEditable).toBe(false);
  });

  test('sign out and verify cleanup', async ({ page }) => {
    // Ensure we're signed in
    const hasAgent = await page.evaluate(() => {
      return localStorage.getItem('agent') !== null;
    });
    
    if (!hasAgent) {
      await page.goto(`${SERVER_URL}/setup`);
      await page.getByRole('button', { name: 'Accept' }).click();
      await page.waitForURL(/\/(app)?$/);
    }
    
    // Go to agent page
    await openAgentPage(page);
    await expect(page.getByRole('button', { name: 'Edit profile' })).toBeVisible();
    
    // Set up dialog handler before signing out
    page.on('dialog', dialog => {
      dialog.accept();
    });
    
    // Sign out
    await page.click('[data-test="sign-out"]');
    
    // Verify we're signed out
    await expect(
      page.getByText(/sign in|enter.*secret|no agent/i).first()
    ).toBeVisible({ timeout: 10000 });
    
    // Verify agent data is cleared
    const agentData = await page.evaluate(() => {
      return {
        agent: localStorage.getItem('agent'),
        agentSubject: localStorage.getItem('agentSubject')
      };
    });
    
    expect(agentData.agent).toBeNull();
    
    // Verify state persists after reload
    await page.reload();
    
    await expect(
      page.getByText(/sign in|enter.*secret|no agent/i).first()
    ).toBeVisible({ timeout: 10000 });
  });

  test('verify write permissions', async ({ page, browser }) => {
    // Ensure we're signed in as user 1
    const hasAgent = await page.evaluate(() => {
      return localStorage.getItem('agent') !== null;
    });
    
    if (!hasAgent) {
      await page.goto(`${SERVER_URL}/setup`);
      await page.getByRole('button', { name: 'Accept' }).click();
      await page.waitForURL(/\/(app)?$/);
    }
    
    // Create a new drive
    const { driveURL, driveTitle } = await newDrive(page);
    
    // Create a document in the drive
    await page.getByTestId('sidebar-new-resource').click();
    await page.locator('button:has-text("Document")').click();
    await editableTitle(page).click();
    await editableTitle(page).fill('Test Document');
    await page.keyboard.press('Escape');
    
    const documentURL = await page.evaluate(() => window.location.href);
    
    // Open a new incognito context (simulating another user)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    
    // Try to access the document without authentication
    await page2.goto(documentURL);
    
    // Should see an error or restricted access
    await expect(
      page2.getByText(/unauthorized|forbidden|not allowed|sign in/i).first()
    ).toBeVisible({ timeout: 10000 });
    
    await context2.close();
    
    // Now make the drive public (read-only)
    await page.goto(driveURL);
    await makeDrivePublic(page);
    
    // Open another incognito context
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();
    
    // Access the document without authentication
    await page3.goto(documentURL);
    
    // Should be able to see the document
    await expect(page3.getByText('Test Document')).toBeVisible();
    
    // But should not be able to edit
    const titleElement = page3.getByTestId('editable-title');
    await titleElement.click();
    
    // Check if editing is disabled
    const isEditable = await titleElement.isEditable();
    expect(isEditable).toBe(false);
    
    await context3.close();
  });
});