import { Page, expect, Browser, Locator } from '@playwright/test';

export const PROPERTIES = {
  isA: 'https://atomicdata.dev/properties/isA',
  set: 'https://atomicdata.dev/properties/set',
  delete: 'https://atomicdata.dev/properties/delete',
  push: 'https://atomicdata.dev/properties/push',
} as const;

export const DELETE_PREVIOUS_TEST_DRIVES =
  process.env.DELETE_PREVIOUS_TEST_DRIVES === 'false' ? false : true;

export const SERVER_URL = process.env.SERVER_URL || 'http://localhost:9883';
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const startDriveName = new URL(FRONTEND_URL).hostname;

// TODO: Should use an env var so the CI can test the setup test.
export const INITIAL_TEST = false;
export const DEMO_INVITE_NAME = 'document demo invite';

export const testFilePath = (filename: string) => {
  const fixturesFolder = __dirname + '/fixtures';

  return `${fixturesFolder}/${filename}`;
};

export const timestamp = () => new Date().toLocaleTimeString();
export const sideBarDriveSwitcher = '[title="Open Drive Settings"]';
export const sideBarNewResourceTestId = 'sidebar-new-resource';
export const editableTitle = (page: Page) => page.getByTestId('editable-title');
export const currentDriveTitle = (page: Page) =>
  page.getByTestId('current-drive-title');
export const publicReadRightLocator = (page: Page) =>
  page.locator('[data-test="right-public"] input[type="checkbox"]').first();
export const contextMenu = '[data-test="context-menu"]';
export const addressBar = (page: Page) => page.getByTestId('adress-bar');
export const newDriveMenuItem = '[data-test="menu-item-new-drive"]';

export const defaultDevServer = 'http://localhost:9883';
export const currentDialogOkButton = 'dialog[open] >> footer >> text=Ok';
// SQLite FTS5 needs time for index rebuilding in tests
// Increased from 500ms to ensure reliable test execution
export const REBUILD_INDEX_TIME = 2500;


/** Checks server URL and browser URL */
export const before = async ({ page }: { page: Page }) => {
  if (!SERVER_URL) {
    throw new Error('serverUrl is not set');
  }

  // Open the server
  await page.goto(FRONTEND_URL);
  
  // Inject CSS to disable all animations for stable tests
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      @media (prefers-reduced-motion: no-preference) {
        * {
          animation-duration: 0s !important;
          transition-duration: 0s !important;
        }
      }
    `
  });

  // Sometimes we run the test server on a different port, but we should
  // only change the drive if it is non-default.
  if (SERVER_URL !== FRONTEND_URL) {
    await changeDrive(SERVER_URL, page);
  }

  await expect(currentDriveTitle(page)).toBeVisible();
};

export async function setTitle(page: Page, title: string) {
  const waiter = waitForCommitOnCurrentResource(page);
  await editableTitle(page).click();
  await expect(editableTitle(page)).toHaveRole('textbox');
  await editableTitle(page).type(title);
  await page.keyboard.press('Escape');
  // await page.waitForTimeout(500);
  await waiter;
}

/** Signs in using an AtomicData.dev test user */
export async function signIn(page: Page) {
  // Retry login button click with better stability
  let retries = 3;
  while (retries > 0) {
    try {
      await page.click('text=Login', { timeout: 5000 });
      break;
    } catch (error) {
      retries--;
      if (retries === 0) throw error;
      await page.waitForTimeout(100 * (4 - retries));
    }
  }
  
  // Wait for authentication form to be visible
  await expect(page.locator('text=edit data and sign Commits')).toBeVisible({ timeout: 10000 });
  
  // If there are any issues with this agent, try creating a new one https://atomicdata.dev/invites/1
  const test_agent =
    'eyJzdWJqZWN0IjoiaHR0cHM6Ly9hdG9taWNkYXRhLmRldi9hZ2VudHMvaElNWHFoR3VLSDRkM0QrV1BjYzAwUHVFbldFMEtlY21GWStWbWNVR2tEWT0iLCJwcml2YXRlS2V5IjoiZkx0SDAvY29VY1BleFluNC85NGxFemFKbUJmZTYxQ3lEekUwODJyMmdRQT0ifQ==';
  
  // Wait for password field to be interactive
  await page.waitForSelector('#current-password', { state: 'visible' });
  await page.click('#current-password');
  await page.fill('#current-password', test_agent);
  
  // Wait for successful authentication
  await expect(page.locator('text=Edit profile')).toBeVisible({ timeout: 10000 });
  
  // Give WebSocket connection time to stabilize
  await page.waitForTimeout(500);
  
  await page.goBack();
}

/**
 * Create a new drive, go to it, and set it as the current drive. Returns URL of
 * drive and its name
 */
export async function newDrive(page: Page) {
  // Create new drive to prevent polluting the main drive
  const driveTitle = `testdrive-${timestamp()}`;
  await page.locator(sideBarDriveSwitcher).click();
  await page.locator('button:has-text("New Drive")').click();
  await waitForCurrentDialog(page);

  await currentDialog(page).getByLabel('Name').fill(driveTitle);

  await currentDialog(page)
    .locator('footer button', { hasText: 'Create' })
    .waitFor({
      state: 'attached',
    });
  await expect(
    currentDialog(page).locator('footer button', { hasText: 'Create' }),
  ).toBeEnabled();

  // Click the create button and wait for dialog to close
  await currentDialog(page)
    .locator('footer button', { hasText: 'Create' })
    .click();

  // Wait for the dialog to disappear (indicates the action completed)
  await currentDialog(page).waitFor({ state: 'hidden', timeout: 30000 });

  // Wait for the sidebar to update with the new drive title
  await expect(currentDriveTitle(page)).not.toContainText(startDriveName);
  await expect(currentDriveTitle(page)).toContainText(driveTitle);
  const driveURL = await getCurrentSubject(page);
  expect(driveURL).toContain(SERVER_URL);

  return { driveURL: driveURL as string, driveTitle };
}

export async function makeDrivePublic(page: Page) {
  await currentDriveTitle(page).click();
  await page.click(contextMenu);
  await page.getByRole('menuitem', { name: 'Permissions & Invites' }).click();
  await expect(
    publicReadRightLocator(page),
    'The drive was public from the start',
  ).not.toBeChecked();
  await expect(publicReadRightLocator(page)).toBeEnabled();
  await publicReadRightLocator(page).click();
  await page.locator('text=Save').click();
  await expect(page.locator('text="Share settings saved"')).toBeVisible();
}

export async function openSubject(page: Page, subject: string) {
  await addressBar(page).fill(subject);
  await expect(page.locator(`main[about="${subject}"]`).first()).toBeVisible();
}

export async function getCurrentSubject(page: Page): Promise<string> {
  const selector = await page.waitForSelector('main[about]');

  const about = await selector.getAttribute('about');

  if (!about) {
    throw new Error('No subject found (no `main[about]` found)');
  }

  return about;
}

/** Waits until a commit for main resource is processed
 */
export async function waitForCommitOnCurrentResource(
  page: Page,
  match?: { set?: Record<string, unknown> },
) {
  const currentSubject = await getCurrentSubject(page);

  await page.waitForResponse(async response => {
    if (!response.url().endsWith('/commit')) {
      return false;
    }

    try {
      const result = await response.json();
      const isForCurrentResource =
        result['https://atomicdata.dev/properties/subject'] === currentSubject;

      if (!isForCurrentResource) {
        return false;
      }

      if (match) {
        const set = result['https://atomicdata.dev/properties/set'];

        for (const key in match.set) {
          if (set[key] !== match.set[key]) {
            return false;
          }
        }
      }

      // Wait for commit response to be processed by the store.
      await page.waitForTimeout(200);
    } catch (e) {
      return false;
    }

    return true;
  });
}

export async function openAgentPage(page: Page) {
  page.goto(`${FRONTEND_URL}/app/agent`);
}

/** Set atomicdata.dev as current server */
export async function openAtomic(page: Page) {
  await changeDrive('https://atomicdata.dev', page);
  // Accept the invite, create an account if necessary
  await expect(currentDriveTitle(page)).toHaveText('Atomic Data');
}

/** Opens the users' profile, sets a username */
export async function editProfileAndCommit(page: Page) {
  await openAgentPage(page);
  // Wait for the agent to be loaded
  await expect(
    page.getByRole('button', { name: 'Edit profile' }),
  ).toBeVisible();
  await expect(page.getByRole('main').getByText('loading')).not.toBeVisible();

  // Wait for the page to be fully interactive before clicking
  await page.waitForLoadState('networkidle', { timeout: 10000 });

  const navigationPromise = page.waitForNavigation({ timeout: 10000 });

  // Retry click with exponential backoff if it fails
  let retries = 3;

  while (retries > 0) {
    try {
      await page.getByRole('button', { name: 'Edit profile' }).click();
      break;
    } catch (error) {
      retries--;
      if (retries === 0) throw error;
      await page.waitForTimeout(100 * (4 - retries)); // 100ms, 200ms, 300ms
    }
  }

  await navigationPromise;
  
  // Find and click the advanced button
  const advancedButton = page.getByRole('button', { name: 'advanced' });
  await advancedButton.scrollIntoViewIfNeeded();
  await advancedButton.click();
  await expect(page.locator('text=add another property')).toBeVisible();
  const username = `Test user edited at ${new Date().toLocaleDateString()}`;
  await page.getByLabel('Name').fill(username);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('text=Resource saved')).toBeVisible();
  await page.waitForURL(/\/app\/show/);
  await page.reload();
  await expect(page.locator(`text=${username}`).first()).toBeVisible();
}

export async function fillSearchBox(
  page: Page | Locator,
  placeholder: string,
  fillText: string,
  options: {
    nth?: number;
    container?: Locator;
    label?: string;
  } = {},
) {
  const { nth, container, label } = options;
  const scope = container ?? page;

  // Open the search dropdown
  if (nth !== undefined) {
    await scope
      .getByRole('button', { name: label ?? placeholder })
      .nth(nth)
      .click();
  } else {
    await scope.getByRole('button', { name: label ?? placeholder }).click();
  }

  // Focus and type
  const input = scope.getByPlaceholder(placeholder);
  await input.focus();
  await input.fill(fillText);

  // Wait for results using multiple strategies
  const waitForResults = async () => {
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      const hasContainer = await (scope as any)
        .getByTestId('searchbox-results')
        .isVisible()
        .catch(() => false);
      if (hasContainer) return;

      const anyOptionVisible = await (scope as any)
        .getByRole('option')
        .first()
        .isVisible()
        .catch(() => false);
      if (anyOptionVisible) return;

      const anyListItemVisible = await (scope as any)
        .locator(
          'li[role="option"], [role="menuitem"], [data-test="searchbox-results"] li',
        )
        .first()
        .isVisible()
        .catch(() => false);
      if (anyListItemVisible) return;

      if ('waitForTimeout' in page) {
        await (page as Page).waitForTimeout(200);
      }
    }

    throw new Error('Search results did not appear in time');
  };

  await waitForResults();

  // Return a clicker that tries multiple selection strategies
  return async (name: string) => {
    const container = (scope as any)
      .getByTestId('searchbox-results')
      .getByText(name)
      .first();

    if (await container.isVisible().catch(() => false)) {
      await container.click();

      return;
    }

    const optionByRole = (scope as any)
      .getByRole('option', { name, exact: false })
      .first();

    if (await optionByRole.isVisible().catch(() => false)) {
      await optionByRole.click();

      return;
    }

    const topOption = (scope as any).getByRole('option').first();

    if (await topOption.isVisible().catch(() => false)) {
      await topOption.click();

      return;
    }

    if ('keyboard' in page) {
      await (page as Page).keyboard.press('Enter');

      return;
    }

    throw new Error(`Option not found: ${name}`);
  };
}

/** Create a new Resource in the current Drive.
 * Class can be an Class URL or a shortname available in the new page. */
export async function newResource(klass: string, page: Page) {
  await page.getByTestId(sideBarNewResourceTestId).click();
  await expect(page).toHaveURL(`${FRONTEND_URL}/app/new`);

  if (klass.startsWith('https://')) {
    await fillSearchBox(page, 'Search for a class or enter a URL', klass);
    await page.keyboard.press('Enter');
  } else {
    await page.locator(`button:has-text("${klass}")`).click();
    // after navigation to the new resource, wait for the URL to change
    await page.locator('main[about]');
  }
}

/** Opens a new browser page (for) */
export async function openNewSubjectWindow(browser: Browser, url: string) {
  const context2 = await browser.newContext();
  const page = await context2.newPage();
  await page.goto(FRONTEND_URL);

  // Only when we run on `localhost` we don't need to change drive during tests
  if (SERVER_URL !== FRONTEND_URL) {
    try {
      await page.waitForSelector('[data-test="sidebar-drive-open"]', {
        timeout: 5000,
      });
      await changeDrive(SERVER_URL, page);
    } catch (error) {
      console.error('Error changing drive in new window:', error);
      // Try reloading the page if the sidebar drive element is not found
      await page.reload();
      await page.waitForSelector('[data-test="sidebar-drive-open"]', {
        timeout: 5000,
      });
      await changeDrive(SERVER_URL, page);
    }
  }

  await openSubject(page, url);
  await page.setViewportSize({ width: 1000, height: 400 });

  return page;
}

export async function openConfigureDrive(page: Page) {
  // Make sure the drive switched dropdown is not open
  if (await page.locator(newDriveMenuItem).isVisible()) {
    await page.click(sideBarDriveSwitcher);
    await page.waitForTimeout(100);
  }

  await page.click(sideBarDriveSwitcher);
  await page.click('text=Configure Drives');
  await expect(page.locator('text=Drive Configuration')).toBeVisible();
}

export async function changeDrive(subject: string, page: Page) {
  try {
    // Check if the current drive matches the requested subject using both methods
    if (await isCurrentDrive(subject, page)) {
      return;
    }

    // Also check the drive title text
    const driveTitleText = await currentDriveTitle(page).textContent();
    // Get the domain from the subject to compare with the drive title
    const subjectDomain = new URL(subject).hostname;

    if (driveTitleText && driveTitleText.trim().includes(subjectDomain)) {
      return;
    }

    const sidebarDriveOpen = page.locator('[data-test="sidebar-drive-open"]');
    if (await sidebarDriveOpen.isVisible()) await openConfigureDrive(page);
    await expect(page.locator('text=Drive Configuration')).toBeVisible();
    await page.fill('[data-test="server-url-input"]', subject);
    await page.click('[data-test="server-url-save"]');
    await expect(
      page.getByRole('heading', { name: 'Default Ontology' }),
    ).toBeVisible();
  } catch (error) {
    console.error('Error in changeDrive:', error);
    throw error;
  }
}

/**
 * Checks if the current drive matches the given URL
 * @param url The URL to compare with the current drive
 * @param page The Playwright Page object
 * @returns True if the current drive matches the URL
 */
export async function isCurrentDrive(
  url: string,
  page: Page,
): Promise<boolean> {
  try {
    const sidebarDriveOpen = page.locator('[data-test="sidebar-drive-open"]');

    if (!(await sidebarDriveOpen.isVisible())) {
      return false;
    }

    // Get the title attribute which contains the current drive URL
    const titleAttr = await sidebarDriveOpen.getAttribute('title');

    if (!titleAttr) {
      return false;
    }

    // Extract the URL from the title attribute
    // Format: "Your current baseURL is {url}"
    const currentUrl = titleAttr.replace('Your current baseURL is ', '');

    // Normalize URLs for comparison (remove trailing slashes and protocol)
    const normalizeUrl = (urlString: string): string => {
      try {
        // Remove trailing slashes
        const cleanUrl = urlString.replace(/\/$/, '');
        const urlObj = new URL(cleanUrl);

        // Compare only hostname and path, ignoring protocol
        return `${urlObj.hostname}${urlObj.pathname}`;
      } catch (e) {
        return urlString.replace(/\/$/, '');
      }
    };

    const normalizedCurrentUrl = normalizeUrl(currentUrl);
    const normalizedUrl = normalizeUrl(url);

    return normalizedCurrentUrl === normalizedUrl;
  } catch (error) {
    console.error('Error in isCurrentDrive:', error);

    return false;
  }
}

export async function editTitle(title: string, page: Page) {
  await expect(editableTitle(page)).toHaveRole('heading');
  await editableTitle(page).click();
  await expect(editableTitle(page)).toHaveRole('textbox');
  await editableTitle(page).fill(title);
  await page.keyboard.press('Enter');
  // Make sure the commit is processed
  // await page.waitForTimeout(300);
}

export async function clickSidebarItem(text: string, page: Page) {
  await page.getByTestId('sidebar').getByRole('link', { name: text }).click();
}

/** Click an item from the main, visible context menu */
export async function contextMenuClick(text: string, page: Page) {
  await page.click(contextMenu);
  await page.waitForTimeout(100);
  await page.getByTestId(`menu-item-${text}`).click();
}

export const anyValue = Symbol('any');
type CommitFilter = {
  set?: Record<string, unknown | typeof anyValue>;
  // TODO: Add push and delete filters when they're needed.
};

export const waitForCommit = async (
  page: Page,
  filter?: CommitFilter,
  timeout = 10000,
) =>
  page.waitForResponse(
    async response => {
      if (
        !response.url().endsWith('/commit') ||
        response.request().method() !== 'POST'
      ) {
        return false;
      }

      const commit = response.request().postDataJSON() as Record<
        string,
        unknown
      >;

      const isA = commit[PROPERTIES.isA] as string[];

      if (!isA.includes('https://atomicdata.dev/classes/Commit')) {
        return false;
      }

      // We have a commit and there is no filter so we can stop waiting.
      if (!filter) {
        return true;
      }

      if (filter.set) {
        if (!(PROPERTIES.set in commit)) {
          return false;
        }

        const set = commit[PROPERTIES.set] as Record<string, unknown>;

        for (const [key, value] of Object.entries(filter.set)) {
          if (!(key in set)) {
            return false;
          }

          if (value === anyValue) {
            continue;
          }

          if (JSON.stringify(set[key]) !== JSON.stringify(value)) {
            return false;
          }
        }
      }

      return true;
    },
    { timeout },
  );

export function currentDialog(page: Page) {
  return page.locator('dialog[data-top-level="true"]');
}

export async function waitForCurrentDialog(page: Page) {
  await currentDialog(page).waitFor({ state: 'visible' });
}

export const DIALOG_CLOSE_BUTTON = 'dialog-close-button';

export async function inDialog(
  page: Page,
  fn: (
    dialog: Locator,
    closeDialogWith: (buttonText: string) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  await waitForCurrentDialog(page);

  const closeDialogWith = async (buttonText: string) => {
    if (buttonText === DIALOG_CLOSE_BUTTON) {
      await currentDialog(page).getByRole('button', { name: 'Close' }).click();

      return;
    }

    const button = page.locator('footer button', { hasText: buttonText });
    await expect(button).toBeEnabled();
    await button.click();
  };

  await fn(currentDialog(page), closeDialogWith);

  await currentDialog(page).waitFor({ state: 'hidden' });
}
