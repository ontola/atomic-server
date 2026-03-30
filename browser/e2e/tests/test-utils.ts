import { Page, expect, Browser, Locator } from '@playwright/test';

export const PROPERTIES = {
  isA: 'https://atomicdata.dev/properties/isA',
  set: 'https://atomicdata.dev/properties/set',
  delete: 'https://atomicdata.dev/properties/delete',
  push: 'https://atomicdata.dev/properties/push',
} as const;

export const SECRET =
  'eyJwcml2YXRlS2V5IjoiVUZDV2xoMGM0b05XVm4ySnNXbndWRVp0VXVEZXBpQmRQelFRMWVVcjdLbz0iLCJzdWJqZWN0IjoiZGlkOmFkOmFnZW50OmdKUlpWVEdQbmdhRzNtU1BBL2U2TEVld0tpeFlwWnR1VVlRaE5nK3Q3WTQ9IiwiaW5pdGlhbERyaXZlIjoiZGlkOmFkOmJiWlRJd2hBbFdhQjl0enpuUVpVSlB0QlhldGhvSFcxYmpMc3VhMXQ5RUtYU3ZNU0k3TWdaKzg0bzJsRGZKR0lhbk8zai8zb2xYNTNwam9GWGVwT0RnPT0ifQ==';

export const SERVER_URL = process.env.SERVER_URL || 'http://localhost:9883';
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export const DEMO_INVITE_NAME = 'document demo invite';

export const testFilePath = (filename: string) => {
  const fixturesFolder = __dirname + '/fixtures';

  return `${fixturesFolder}/${filename}`;
};

export const timestamp = () => new Date().toLocaleTimeString();
export const sideBarDriveSwitcher = (page: Page) =>
  page.getByTitle('Open Drive Settings');
export const sideBarNewResourceTestId = 'sidebar-new-resource';

/** Sidebar "New" → `/app/new` (scoped so drive/folder QuickCreateRow duplicates do not match). */
export const sidebarNewResourceButton = (page: Page) =>
  page.getByTestId('sidebar').getByTestId(sideBarNewResourceTestId);

/**
 * Top bar Share control. `getByRole('button', { name: 'Share' })` matches twice because
 * ShareDialog wraps the trigger in a `div[role="button"]` around the real `<button>`.
 */
export const topBarShareButton = (page: Page) =>
  page.locator('[aria-label="navigation"] button').filter({ hasText: 'Share' });
export const editableTitle = (page: Page) => page.getByTestId('editable-title');
export const currentDriveTitle = (page: Page) =>
  page.getByTestId('current-drive-title');
export const publicReadRightLocator = (page: Page) =>
  page
    .locator(
      '[data-test="right-public"] input[type="checkbox"]:not([disabled])',
    )
    .first();
export const contextMenu = '[data-test="context-menu"]';
export const addressBar = (page: Page) => page.getByTestId('adress-bar');
export const newDriveMenuItem = '[data-test="menu-item-new-drive"]';
export const sidebarDriveButtonId = 'sidebar-drive-open';
export const defaultDevServer = 'http://localhost:9883';
export const currentDialogOkButton = 'dialog[open] >> footer >> text=Ok';
// Depends on server index throttle time, `commit_monitor.rs`
export const REBUILD_INDEX_TIME = 5000;

/**
 * Default test setup: `/app/dev-drive` creates a fresh agent + drive on the dev
 * server and switches to it. Most specs use `test.beforeEach(before)` so every
 * test starts isolated without extra navigation.
 */
export const before = async ({ page }: { page: Page }): Promise<void> => {
  if (!SERVER_URL) {
    throw new Error('serverUrl is not set');
  }

  await devDrive(page);
};

/**
 * Agent secret from the last `devDrive()` / `before()` (stored in localStorage).
 * Use for second browser contexts that must sign in as the same user.
 */
export async function getDevDriveSecret(page: Page): Promise<string> {
  const secret = await page.evaluate(() =>
    localStorage.getItem('atomic-test.dev-drive-secret'),
  );

  if (!secret) {
    throw new Error(
      'getDevDriveSecret: missing atomic-test.dev-drive-secret — run devDrive or before() first',
    );
  }

  return secret;
}

export async function setTitle(page: Page, title: string) {
  const waiter = waitForCommitOnCurrentResource(page);
  await editableTitle(page).click();
  await expect(editableTitle(page)).toHaveRole('textbox');
  await editableTitle(page).type(title);
  await page.keyboard.press('Escape');
  await waiter;
}

/**
 * Signs in with the shared test secret. Works from the drive (sidebar → Login)
 * or from `/app/agent` / welcome gate (card: Sign in → secret → Continue).
 */
export async function signIn(page: Page, secret: string = SECRET) {
  const loginLink = page.getByRole('link', { name: 'Login / New User' });
  const usedSidebarNav = await loginLink
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (usedSidebarNav) {
    await loginLink.click();
  }

  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Agent secret').fill(secret);
  await page.getByRole('button', { name: 'Continue' }).click();

  if (usedSidebarNav) {
    await page.goBack();
  }
}

/**
 * Quick dev setup: navigates to /app/dev-drive which creates a fresh agent +
 * drive on localhost:9883 and switches to it automatically.
 * Returns the agent secret so other pages/contexts can sign in as the same user.
 */
export async function devDrive(page: Page): Promise<string> {
  await page.goto(`${FRONTEND_URL}/app/dev-drive`);
  await page.waitForURL(/did(?:%3A|:)ad(?:%3A|:)/, { timeout: 30000 });
  await expect(currentDriveTitle(page)).toBeVisible({ timeout: 15000 });

  const secret = await page.evaluate(() =>
    localStorage.getItem('atomic-test.dev-drive-secret'),
  );

  if (!secret) {
    throw new Error('devDrive: agent secret not found in localStorage');
  }

  return secret;
}

/**
 * Create a new drive, go to it, and set it as the current drive. Returns URL of
 * drive and its name
 */
export async function newDrive(page: Page) {
  // Create new drive to prevent polluting the main drive
  const driveTitle = `testdrive-${timestamp()}`;
  const subdomain = `testsub-${Math.random().toString(36).substring(7)}`;

  await expect(sideBarDriveSwitcher(page)).toBeVisible({ timeout: 15000 });

  await sideBarDriveSwitcher(page).click();
  const newDriveButton = page.getByTestId('menu-item-new-drive');
  await expect(newDriveButton).toBeVisible({ timeout: 10000 });
  await newDriveButton.click();
  await waitForCurrentDialog(page);

  const dialog = currentDialog(page);
  await dialog.getByLabel('Name').fill(driveTitle);
  await dialog.getByLabel('Subdomain').fill(subdomain);

  const createButton = dialog.locator('button', { hasText: 'Create' });
  await createButton.waitFor({ state: 'attached' });
  await expect(createButton).toBeEnabled();
  await createButton.click();

  // Wait for the URL to change to did:ad: (newly created drive)
  await page.waitForURL(/did(?:%3A|:)ad(?:%3A|:)/, { timeout: 30000 });
  await expect(currentDriveTitle(page)).toHaveText(driveTitle);
  const driveURL = await getCurrentSubject(page);
  expect(driveURL).toBeTruthy();

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

/** Waits until a commit for main resource is processed */
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

export async function waitForSearchIndex(page: Page) {
  return page.waitForTimeout(REBUILD_INDEX_TIME);
}

export async function openAgentPage(page: Page) {
  await page.goto(`${FRONTEND_URL}/app/agent`);
}

/** Opens the users' profile, sets a username, saves, reloads and verifies the change persisted. */
export async function editProfileAndCommit(page: Page) {
  await openAgentPage(page);
  await expect(
    page.getByRole('button', { name: 'Edit profile' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Edit profile' }).click();
  await page.waitForURL(/\/app\/edit/);

  const nameInput = page.locator('[data-test="input-name"]');
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  const username = `Test user edited at ${new Date().toLocaleDateString()}`;
  await nameInput.fill(username);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('text=Resource saved')).toBeVisible();
  await page.waitForURL(/\/app\/show/);
  await page.reload();
  await expect(page.locator(`text=${username}`).first()).toBeVisible({
    timeout: 10000,
  });
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
  const selector = container ?? page;

  if (nth !== undefined) {
    await selector
      .getByRole('button', { name: label ?? placeholder })
      .nth(nth)
      .click();
  } else {
    await selector.getByRole('button', { name: label ?? placeholder }).click();
  }

  await selector.getByPlaceholder(placeholder).fill(fillText);

  return async (name: string) => {
    await selector.getByTestId('searchbox-results').getByText(name).click();
  };
}

/** Create a new Resource in the current Drive.
 * Class can be an Class URL or a shortname available in the new page. */
export async function newResource(klass: string, page: Page) {
  await sidebarNewResourceButton(page).click();
  await expect(page).toHaveURL(`${FRONTEND_URL}/app/new`);

  const waitForResourcePage = async () => {
    await page.waitForURL(url => !url.pathname.endsWith('/app/new'), {
      timeout: 10000,
    });
  };

  const waitForResourceForm = async () => {
    await Promise.any([
      page.waitForURL(url => !url.pathname.endsWith('/app/new'), {
        timeout: 20000,
      }),
      page
        .locator('[data-test="input-shortname"]')
        .first()
        .waitFor({ state: 'visible', timeout: 20000 }),
      page.getByLabel('Shortname').first().waitFor({
        state: 'visible',
        timeout: 20000,
      }),
      page
        .getByRole('button', { name: 'Save' })
        .first()
        .waitFor({ state: 'visible', timeout: 20000 }),
    ]);
  };

  if (klass.startsWith('https://')) {
    await fillSearchBox(page, 'Search for a class or enter a URL', klass);
    await page.keyboard.press('Enter');
    await waitForResourceForm();
  } else {
    await page.locator(`button:has-text("${klass}")`).click();
    // Some classes (e.g. bookmark, table) open a dialog instead of navigating.
    await Promise.race([
      page.waitForURL(url => !url.pathname.endsWith('/app/new'), {
        timeout: 10000,
      }),
      page
        .locator('dialog[open]')
        .waitFor({ state: 'visible', timeout: 10000 }),
    ]);
  }
}

/** Opens a new browser page for multi-user testing */
export async function openNewSubjectWindow(
  browser: Browser,
  url: string,
  /** If set, sign in as this user */
  secret: string | undefined = undefined,
) {
  const context2 = await browser.newContext();
  const page = await context2.newPage();
  await page.goto(FRONTEND_URL);

  if (secret) {
    if (secret.length < 1) throw new Error('Secret must be provided');
    await signIn(page, secret);
  }

  await openSubject(page, url);
  // await page.setViewportSize({ width: 1000, height: 400 });

  return page;
}

export async function openConfigureDrive(page: Page) {
  await page.goto(`${FRONTEND_URL}/app/server`);
  await expect(
    page.getByRole('heading', { name: 'Drive Configuration' }),
  ).toBeVisible({
    timeout: 10000,
  });
}

export async function changeDrive(
  subject: string,
  page: Page,
  validate: boolean = true,
) {
  try {
    const driveLink = page.getByTestId(sidebarDriveButtonId);
    await expect(driveLink).toBeVisible();
    await openConfigureDrive(page);
    const currentDriveInput = page.getByTestId('drive-url-input');

    if ((await currentDriveInput.inputValue()) === subject) {
      await page.keyboard.press('Escape');

      if (validate) {
        await expect(currentDriveTitle(page)).toBeVisible();
      }

      return;
    }

    await currentDriveInput.fill(subject);
    await page.locator('[data-test="drive-url-save"]').click();
  } catch (e) {
    console.error('Error in changeDrive:', e);
    throw e;
  }
}

export async function editTitle(title: string, page: Page) {
  const titleEl = editableTitle(page);
  // After resource creation, EditableTitle auto-enters edit mode (textbox).
  // If it's still a heading, click to activate edit mode first.
  const isInput = await titleEl.evaluate(el => el.tagName === 'INPUT');
  if (!isInput) {
    await expect(titleEl).toHaveRole('heading');
    await titleEl.click();
    await expect(titleEl).toHaveRole('textbox');
  }
  await titleEl.fill(title);
  await page.keyboard.press('Enter');
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
};

export const waitForCommit = async (page: Page, filter?: CommitFilter) =>
  page.waitForResponse(async response => {
    if (
      !response.url().endsWith('/commit') ||
      response.request().method() !== 'POST'
    ) {
      return false;
    }

    const commit = response.request().postDataJSON() as Record<string, unknown>;

    const isA = commit[PROPERTIES.isA] as string[];

    if (!isA.includes('https://atomicdata.dev/classes/Commit')) {
      return false;
    }

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
  });

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

export async function acceptInvite(page: Page) {
  await page.getByRole('button', { name: 'Accept as new user' }).click();

  await inDialog(page, async (dialog, closeDialog) => {
    await expect(
      dialog.getByRole('heading', { name: 'Agent created!' }),
    ).toBeVisible();
    await dialog.getByLabel('Name').fill(`Test User ${timestamp()}`);
    await dialog.getByRole('button', { name: 'Copy to clipboard' }).click();
    await closeDialog('Continue');
  });
}
