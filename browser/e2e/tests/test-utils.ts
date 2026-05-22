import { Page, expect, Browser, Locator, TestInfo } from '@playwright/test';
import {
  applyCpuThrottle,
  envCpuThrottle,
  registerPerfPage,
} from './perf-attach';

export const PROPERTIES = {
  isA: 'https://atomicdata.dev/properties/isA',
  set: 'https://atomicdata.dev/properties/set',
  delete: 'https://atomicdata.dev/properties/delete',
  push: 'https://atomicdata.dev/properties/push',
  loroUpdate: 'https://atomicdata.dev/properties/loroUpdate',
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
/**
 * The search input inside the search overlay (modal). Only visible after the
 * overlay is opened via the Search button or cmd/ctrl+K. Replaces the old
 * inline contentEditable that had data-testid="adress-bar".
 */
export const searchInput = (page: Page) =>
  page.getByPlaceholder('Search for resources...');

/**
 * Opens the search overlay if not already open. Idempotent — returns the
 * focused input locator.
 */
export async function openSearchOverlay(page: Page) {
  const input = searchInput(page);
  if (!(await input.isVisible().catch(() => false))) {
    await page.locator('nav button[title^="Search ("]').first().click();
    await input.waitFor({ state: 'visible', timeout: 3000 });
  }
  return input;
}

/**
 * Type a search query into the overlay. Opens the overlay first if needed.
 * Clears any existing query, which is important since the input persists
 * across re-opens in the same page session.
 */
export async function typeInSearch(page: Page, text: string) {
  // The search overlay re-renders as results stream in — its input node can
  // be detached and replaced mid-`fill` ("element was detached from the
  // DOM"). Retry against a freshly-resolved locator until the value sticks.
  for (let attempt = 0; attempt < 4; attempt++) {
    const input = await openSearchOverlay(page);
    const ok = await input
      .fill(text)
      .then(() => input.inputValue())
      .then(value => value === text)
      .catch(() => false);

    if (ok) {
      return;
    }
  }

  // Final attempt — surface the error if the input is still unstable.
  const input = await openSearchOverlay(page);
  await input.fill(text);
}

/**
 * Search-and-navigate: open overlay, type query, wait for a result matching
 * `resultText` to appear in the overlay, click it, and wait for navigation
 * to the result's show page. Returns after the overlay closes.
 *
 * Use this instead of the old pattern of typing and pressing Enter — the new
 * overlay requires an explicit result click (or ArrowDown → Enter) and only
 * navigates when a real result is selected, not on raw Enter.
 *
 * Result rows carry a `data-index` attribute
 * (see OverlayContainer.tsx → ResultRowWrapper).
 */
export async function searchAndOpen(
  page: Page,
  query: string,
  resultText: string,
) {
  await typeInSearch(page, query);
  const result = page
    .locator('[data-index]')
    .filter({ hasText: resultText })
    .first();
  await expect(result).toBeVisible({ timeout: 15000 });
  await result.click();
}

/**
 * Deprecated alias — old tests called this. Forwards to the new `typeInSearch`
 * which opens the overlay. Kept so we can migrate tests incrementally.
 * @deprecated use `typeInSearch` or `searchAndOpen`
 */
export async function typeInAddressBar(page: Page, text: string) {
  await typeInSearch(page, text);
}

/**
 * Deprecated alias — old tests used `addressBar(page).fill(...)`. Returns the
 * new search input after opening the overlay. Prefer `typeInSearch`.
 * @deprecated use `searchInput` (and open the overlay first)
 */
export const addressBar = (page: Page) => searchInput(page);
export const newDriveMenuItem = '[data-test="menu-item-new-drive"]';
export const sidebarDriveButtonId = 'sidebar-drive-open';
export const defaultDevServer = 'http://localhost:9883';
export const currentDialogOkButton = 'dialog[open] >> footer >> text=Ok';
// Depends on server index throttle time, `commit_monitor.rs`
export const REBUILD_INDEX_TIME = 6500;

/**
 * Default test setup: `/app/dev-drive` creates a fresh agent + drive on the dev
 * server and switches to it. Most specs use `test.beforeEach(before)` so every
 * test starts isolated without extra navigation.
 */
export const before = async (
  // Accept the second positional `testInfo` argument so we can stash
  // the page for `attachPerfOnFailure`. `beforeEach` callbacks in
  // Playwright receive `(fixtures, testInfo)` — most callers don't
  // need it, but optional second-arg ergonomics keeps the signature
  // backwards-compatible for the dozens of specs that already call
  // `test.beforeEach(before)`.
  { page }: { page: Page },
  testInfo?: TestInfo,
): Promise<void> => {
  if (!SERVER_URL) {
    throw new Error('serverUrl is not set');
  }

  // Optional CPU throttle: simulates dagger's single-core slowdown
  // locally so flaky tests reproduce on a dev box. No-op when the
  // env var is unset.
  const throttle = envCpuThrottle();
  if (throttle) await applyCpuThrottle(page, throttle);

  if (testInfo) registerPerfPage(testInfo, page);

  await installCommitWatcher(page);
  await devDrive(page);
};

/**
 * Mirror outgoing v2 WebSocket COMMIT frames (tag `0x13`) into a
 * `window.__atomicCommitLog` so {@link waitForCommit} can observe
 * commits regardless of transport. Must be installed BEFORE
 * `page.goto(...)` — `addInitScript` runs before any page script,
 * including the SPA bundle that opens the WebSocket.
 *
 * The Store now prefers WS for persisted commits (HTTP `/commit`
 * remains a fallback), so the previous `page.waitForResponse(/commit)`
 * helper alone misses the happy path and tests time out.
 */
export async function installCommitWatcher(page: Page) {
  await page.addInitScript(() => {
    // Idempotent — `before()` may run multiple times against the same
    // browser context if a spec opens additional pages.
    if (
      (window as unknown as { __atomicCommitWatcherInstalled?: boolean })
        .__atomicCommitWatcherInstalled
    ) {
      return;
    }
    (
      window as unknown as { __atomicCommitWatcherInstalled: boolean }
    ).__atomicCommitWatcherInstalled = true;
    (window as unknown as { __atomicCommitLog: unknown[] }).__atomicCommitLog =
      [];

    const COMMIT_TAG = 0x13;
    const ISA = 'https://atomicdata.dev/properties/isA';
    const SUBJECT = 'https://atomicdata.dev/properties/subject';
    const COMMIT_CLASS = 'https://atomicdata.dev/classes/Commit';

    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ) {
      try {
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          const buf =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(
                  (data as ArrayBufferView).buffer,
                  (data as ArrayBufferView).byteOffset,
                  (data as ArrayBufferView).byteLength,
                );

          if (buf[0] === COMMIT_TAG && buf.length >= 3) {
            const json = new TextDecoder().decode(buf.subarray(3));
            const commit = JSON.parse(json) as Record<string, unknown>;
            const isA = commit[ISA] as string[] | undefined;

            if (Array.isArray(isA) && isA.includes(COMMIT_CLASS)) {
              const log = (
                window as unknown as {
                  __atomicCommitLog: Array<{
                    sentAt: number;
                    subject: string;
                    commit: Record<string, unknown>;
                  }>;
                }
              ).__atomicCommitLog;
              log.push({
                sentAt: Date.now(),
                subject: (commit[SUBJECT] as string | undefined) ?? '',
                commit,
              });
            }
          }
        }
      } catch {
        // Best-effort — never break the real send.
      }
      // eslint-disable-next-line prefer-rest-params
      return origSend.apply(this, arguments as unknown as [data: never]);
    };
  });
}

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
  await editableTitle(page).click();
  await expect(editableTitle(page)).toHaveRole('textbox');
  // New resources pre-fill the title input with the class name (e.g. "Folder"),
  // so typing would concatenate ("FolderTestFolder-…"). Select-all + type
  // replaces the existing value.
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+a' : 'Control+a',
  );
  // Read the resource subject BEFORE we close the editor — used to
  // match the commit that carries this rename across either transport.
  const subject = await page.evaluate(() => {
    const main = document.querySelector('main[about]');
    return main?.getAttribute('about') ?? '';
  });
  const renameStartedAt = Date.now();
  // Arm the commit waiter BEFORE pressing Enter — Playwright's
  // `waitForResponse` / `waitForFunction` only see signals that
  // happen AFTER the call is awaited, so installing it first
  // guarantees we don't miss a fast post.
  const commitPosted = waitForCommitForSubject(page, subject, renameStartedAt);
  await editableTitle(page).type(title);
  await page.keyboard.press('Enter');

  // Wait for the commit carrying this resource to complete server-side.
  // This is the definitive signal that the rename has landed — far more
  // reliable than polling `pendingDirtyCount === 0`, which is trivially
  // true before `useValue`'s debounced save fires (the outbox doesn't
  // even know about the change yet).
  //
  // We deliberately DON'T also poll the local store for `name === title`.
  // Plugins / class-extender `after_commit` hooks can transform the
  // commit's value before it's reflected back (e.g. test-plugin
  // prefixes folder names with "My "), so the local store may end up
  // with a derived value. The contract of `setTitle` is "the user's
  // rename has been committed to the server"; what the server (or its
  // plugins) does next is not setTitle's concern.
  await commitPosted;
}

/** Wait for either an HTTP `/commit` POST or a WS COMMIT frame whose
 *  body references `subject` and was sent at or after `since`. */
function waitForCommitForSubject(page: Page, subject: string, since: number) {
  const http = page.waitForResponse(
    r => {
      const request = r.request();
      return (
        r.url().endsWith('/commit') &&
        request.method() === 'POST' &&
        request.timing().startTime >= since &&
        request.postData()?.includes(subject) === true &&
        r.status() < 400
      );
    },
    { timeout: 15000 },
  );
  const ws = page.waitForFunction(
    ({ targetSubject, sinceMs }) => {
      const log =
        (
          window as unknown as {
            __atomicCommitLog?: Array<{
              sentAt: number;
              subject: string;
              commit: Record<string, unknown>;
            }>;
          }
        ).__atomicCommitLog ?? [];
      return log.some(
        entry => entry.sentAt >= sinceMs && entry.subject === targetSubject,
      );
    },
    { targetSubject: subject, sinceMs: since },
    { polling: 100, timeout: 15000 },
  );
  return Promise.race([http, ws]);
}

/**
 * Signs in with the shared test secret if not already signed in.
 *
 * Handles three entry states:
 *   1. Already signed in (e.g. post-`before()`/`devDrive()`): no-op.
 *   2. Welcome gate visible: click its "Sign in" button → paste secret → Continue.
 *   3. On a drive page with a "Login / New User" sidebar link: click it, then
 *      follow the welcome-gate flow, then navigate back.
 *
 * Idempotence is important because `before()` already signs in with a
 * fresh dev-drive agent; tests that also call `signIn(page)` used to pre-empt
 * that by looking for a "Sign in" button that wasn't there.
 */
export async function signIn(page: Page, secret: string = SECRET) {
  // Wait for one of the three states to actually render. Without this, a
  // freshly-navigated page may not yet have the welcome gate or sidebar
  // mounted — visibility checks then time out and we wrongly assume
  // already-signed-in (state 1) when really we just hit the page too early.
  await page
    .locator(
      'button:has-text("Sign in"), a:has-text("Login / New User"), a:has-text("User Settings")',
    )
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => undefined);

  // State 2: welcome gate. The "Sign in" button (exact match, not "Sign in with Google" etc.)
  // is the fast check — if it's there, we're on the gate and need to sign in.
  const signInButton = page.getByRole('button', {
    name: 'Sign in',
    exact: true,
  });
  if (await signInButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await signInButton.click();
    await page.getByLabel('Agent secret').fill(secret);
    // The signin form auto-submits 150ms after the secret is filled
    // (GettingStartedFlow useEffect). Clicking Continue races with that
    // resubmit and can hit a detached element. Try the click but tolerate
    // detach; either path completes the sign-in.
    await page
      .getByRole('button', { name: 'Continue' })
      .click({ timeout: 2000 })
      .catch(() => {
        /* auto-submit raced us; keep going */
      });
    // Wait for the signed-in sidebar to appear. Without this, callers
    // (e.g. `openSubject`) may navigate before the auth cookie + localStorage
    // are written, leaving the next page anonymous (the sidebar then renders
    // a "Login / New User" link instead of "User Settings").
    await page
      .getByRole('link', { name: 'User Settings' })
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => undefined);
    return;
  }

  // State 3: sidebar login link (rare — shown when on a drive but not signed in).
  const loginLink = page.getByRole('link', { name: 'Login / New User' });
  if (await loginLink.isVisible({ timeout: 1500 }).catch(() => false)) {
    await loginLink.click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Agent secret').fill(secret);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.goBack();
    return;
  }

  // State 1: already signed in. Nothing to do.
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
  // The permission toggle dirties the resource asynchronously (validation
  // fetch + LocalChange event), so wait for Save to enable instead of
  // racing the default 5s click timeout.
  const saveBtn = page
    .locator('main')
    .getByRole('button', { name: 'Save', exact: true });
  await expect(saveBtn).toBeEnabled({ timeout: 15000 });
  await saveBtn.click();
  await expect(page.locator('text="Share settings saved"')).toBeVisible();
}

export async function openSubject(page: Page, subject: string) {
  // Navigate via the SPA's /app/show route instead of typing into the old
  // address bar (which no longer exists — replaced by the search overlay,
  // and the overlay only resolves indexed resources, not arbitrary URLs).
  await page.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(subject)}`,
  );
  // Default 5s actionTimeout is too tight under dagger CI: a second-context
  // openSubject has to bootstrap WASM, open a WS, authenticate, and fetch
  // the resource before `main[about=...]` lands. Multi-context tests
  // (authorization invite, multi-user documents) saw routine 10s+ waits.
  await expect(page.locator(`main[about="${subject}"]`).first()).toBeVisible({
    timeout: 20000,
  });
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
  const startedAt = Date.now();

  const httpMatch = page.waitForResponse(async response => {
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
        // Same caveat as waitForCommit: modern Loro-based commits don't
        // populate `set` on the wire. If a loroUpdate is present we accept
        // the commit instead of trying to decode individual props.
        const hasLoroUpdate =
          'https://atomicdata.dev/properties/loroUpdate' in result;

        if (!hasLoroUpdate) {
          const set = result['https://atomicdata.dev/properties/set'];

          for (const key in match.set) {
            if (set[key] !== match.set[key]) {
              return false;
            }
          }
        }
      }
    } catch (e) {
      return false;
    }

    return true;
  });

  const wsMatch = page.waitForFunction(
    ({ targetSubject, sinceMs, matchSet, setProp, subjectProp, loroProp }) => {
      const log =
        (
          window as unknown as {
            __atomicCommitLog?: Array<{
              sentAt: number;
              subject: string;
              commit: Record<string, unknown>;
            }>;
          }
        ).__atomicCommitLog ?? [];
      return log.some(entry => {
        if (entry.sentAt < sinceMs) return false;
        const commit = entry.commit;
        if (commit[subjectProp] !== targetSubject) return false;
        if (!matchSet) return true;
        const hasLoroUpdate = loroProp in commit;
        if (hasLoroUpdate) return true;
        const setMap = commit[setProp] as Record<string, unknown> | undefined;
        if (!setMap) return false;
        return Object.keys(matchSet).every(
          key => setMap[key] === matchSet[key],
        );
      });
    },
    {
      targetSubject: currentSubject,
      sinceMs: startedAt,
      matchSet: (match?.set ?? null) as Record<string, unknown> | null,
      setProp: PROPERTIES.set,
      subjectProp: 'https://atomicdata.dev/properties/subject',
      loroProp: PROPERTIES.loroUpdate,
    },
    { polling: 100, timeout: 15000 },
  );

  await Promise.race([httpMatch, wsMatch]);
  // Give the store a beat to apply the response before callers assert
  // — matches the prior `waitForTimeout(200)` after HTTP detection.
  await page.waitForTimeout(200);
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
  placeholder: string | RegExp,
  fillText: string,
  options: {
    nth?: number;
    container?: Locator;
    label?: string | RegExp;
  } = {},
) {
  const { nth, container, label } = options;
  const selector = container ?? page;

  // Many search inputs are directly visible; others are hidden behind a
  // button that must be clicked first (legacy pattern). Only click the
  // button if the input isn't already in view.
  const inputLocator = selector.getByPlaceholder(placeholder);
  const inputVisible = await inputLocator
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);

  if (!inputVisible) {
    if (nth !== undefined) {
      await selector
        .getByRole('button', { name: label ?? placeholder })
        .nth(nth)
        .click();
    } else {
      await selector
        .getByRole('button', { name: label ?? placeholder })
        .click();
    }
  }

  await inputLocator.fill(fillText);

  return async (name: string) => {
    await selector.getByTestId('searchbox-results').getByText(name).click();
  };
}

/**
 * SearchBox placeholder is templated as `Search for a ${typeResource.title} or
 * enter a URL...`. The title can resolve to "property", but also to other
 * resource titles depending on store state — match the stable prefix/suffix
 * instead of pinning a specific title.
 */
export const SEARCHBOX_PROPERTY_PLACEHOLDER = /Search for a .+ or enter a URL/;

/** Create a new Resource in the current Drive.
 * Class can be an Class URL or a shortname available in the new page. */
export async function newResource(klass: string, page: Page) {
  await sidebarNewResourceButton(page).click();
  // Sidebar "New" navigates to /app/new?parentSubject=<parent> to preserve
  // the container context (see QuickCreateRow). Match pathname only.
  await expect(page).toHaveURL(/\/app\/new(\?|$)/);

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
    // Wait for any of: URL leaves /app/new (basic-instance handlers), a
    // dialog opens (bookmark/table), or the in-place NewFormFullPage shows
    // up (custom user classes — `/app/new?classSubject=...` keeps the path
    // but renders the resource form).
    await Promise.any([
      page.waitForURL(url => !url.pathname.endsWith('/app/new'), {
        timeout: 10000,
      }),
      page
        .locator('dialog[open]')
        .waitFor({ state: 'visible', timeout: 10000 }),
      page
        .getByRole('button', { name: 'Save' })
        .first()
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

  // Frontend route URLs (e.g. invite links pointing at /app/invite) need to
  // be visited directly — wrapping them in /app/show?subject=... would treat
  // them as resources to fetch and the server has no such resource.
  if (url.includes('/app/')) {
    await page.goto(url);
  } else {
    await openSubject(page, url);
  }

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
  // If we land on the heading variant (e.g. when reusing an existing resource),
  // click to activate edit mode. Poll briefly because the heading→textbox
  // transition is async on creation.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const tag = await titleEl.evaluate(el => el.tagName).catch(() => '');
    if (tag === 'INPUT') break;
    if (tag === 'H1') {
      await titleEl.click();
      await expect(titleEl).toHaveRole('textbox');
      break;
    }
    await page.waitForTimeout(100);
  }
  // Watch for the commit BEFORE typing so we don't miss the response that
  // fires during the debounced save.
  const waiter = waitForCommitOnCurrentResource(page);
  // Select-all + type rather than fill: fill replaces the input value via
  // direct DOM mutation, but React's controlled input + useValue debounce
  // sometimes drops the change. Per-character type events keep onChange firing
  // on every keystroke and let the debounce settle naturally.
  await titleEl.focus();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+a' : 'Control+a',
  );
  await titleEl.type(title);
  await page.keyboard.press('Enter');
  await waiter;
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

/**
 * Resolve when a commit matching `filter` lands on the server. Watches
 * BOTH transports so the helper survives the WS-first commit path:
 *
 * - HTTP `POST /commit` responses (fallback path, anonymous flows, multi-server)
 * - WS `COMMIT` frames captured by {@link installCommitWatcher} into
 *   `window.__atomicCommitLog`
 *
 * Whichever signal fires first wins. The promise resolves once a match
 * is found; rejecting is left to the surrounding `expect`/test timeout.
 */
export const waitForCommit = async (page: Page, filter?: CommitFilter) => {
  // Capture wall-clock at call-time so the WS matcher only resolves
  // on commits sent AFTER this point — matches `waitForResponse`'s
  // future-only semantics. Without this, pre-existing entries in
  // `__atomicCommitLog` would resolve the helper immediately.
  const since = Date.now();
  return Promise.any([
    waitForHttpCommit(page, filter),
    waitForWsCommit(page, filter, since),
  ]);
};

const waitForWsCommit = (
  page: Page,
  filter: CommitFilter | undefined,
  since: number,
) =>
  page.waitForFunction(
    ({ filterSet, isAProp, setProp, loroProp, commitClass, sinceMs }) => {
      const log =
        (
          window as unknown as {
            __atomicCommitLog?: Array<{
              sentAt: number;
              subject: string;
              commit: Record<string, unknown>;
            }>;
          }
        ).__atomicCommitLog ?? [];

      return log.some(entry => {
        if (entry.sentAt < sinceMs) return false;
        const commit = entry.commit;
        const isA = commit[isAProp] as string[] | undefined;
        if (!Array.isArray(isA) || !isA.includes(commitClass)) return false;

        if (!filterSet) return true;

        const hasLoroUpdate = loroProp in commit;
        // Mirrors the HTTP filter below: a Loro-bearing commit can't be
        // inspected per-property here, so a `set` filter degrades to a
        // match on any Commit carrying a loroUpdate.
        if (hasLoroUpdate) return true;

        const setMap = commit[setProp] as Record<string, unknown> | undefined;
        if (!setMap) return false;
        return Object.keys(filterSet).every(key => key in setMap);
      });
    },
    {
      filterSet: (filter?.set ?? null) as Record<string, unknown> | null,
      isAProp: PROPERTIES.isA,
      setProp: PROPERTIES.set,
      loroProp: PROPERTIES.loroUpdate,
      commitClass: 'https://atomicdata.dev/classes/Commit',
      sinceMs: since,
    },
    { polling: 100, timeout: 15000 },
  );

const waitForHttpCommit = (page: Page, filter?: CommitFilter) =>
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

    // Modern commits carry all property changes inside `loroUpdate` — the
    // `set` map on the wire is empty. `filter.set` used to match by property
    // URL; with Loro we can't decode those bytes here, so if the commit has a
    // `loroUpdate` we accept it. Callers that care about exact property
    // values should assert on the rendered UI instead.
    if (!filter) {
      return true;
    }

    const hasLoroUpdate = PROPERTIES.loroUpdate in commit;

    if (filter.set) {
      if (hasLoroUpdate) {
        // Can't read individual props from the binary update — treat any
        // Loro-bearing commit as a match when a `set` filter was requested.
        return true;
      }

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
  return page.locator('dialog[open][data-top-level="true"]');
}

export async function waitForCurrentDialog(page: Page) {
  // Default waitFor uses the 5s `actionTimeout`. Several dialogs only open
  // after a server round-trip (plugin upload parses the zip server-side, file
  // chooser uploads the file, etc.). 20s covers the slow path without
  // hiding genuine hangs.
  await currentDialog(page).waitFor({ state: 'visible', timeout: 20000 });
}

export const DIALOG_CLOSE_BUTTON = 'dialog-close-button';

/** Click history version buttons until the preview panel shows `text`. */
export async function selectHistoryVersionShowing(
  page: Page,
  text: string,
): Promise<void> {
  const buttons = page.getByTestId('version-button');
  const count = await buttons.count();

  for (let i = 0; i < count; i++) {
    await buttons.nth(i).click();
    const visible = await page
      .getByText(text, { exact: true })
      .first()
      .isVisible()
      .catch(() => false);

    if (visible) {
      return;
    }
  }

  throw new Error(`No history version preview shows "${text}"`);
}

export async function inDialog(
  page: Page,
  fn: (
    dialog: Locator,
    closeDialogWith: (buttonText: string) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  await waitForCurrentDialog(page);

  const closeDialogWith = async (buttonText: string) => {
    const button =
      buttonText === DIALOG_CLOSE_BUTTON
        ? currentDialog(page).getByRole('button', { name: 'Close' })
        : currentDialog(page).locator('footer button', { hasText: buttonText });

    // The dialog footer re-renders while an async commit settles — the
    // Save/Create button is detached and replaced under Playwright's
    // click ("element is not stable" / "element was detached from the
    // DOM"). A single click then races that churn and times out.
    //
    // Retry the click while the dialog is still open: every
    // `closeDialogWith` call is meant to dismiss the dialog, so a click
    // that took effect closes it (and further clicks hit nothing), while
    // a click that lost the detach race leaves it open for another try.
    // Bounded, so a genuinely stuck dialog still fails loudly.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await currentDialog(page).isHidden()) {
        return;
      }

      await expect(button).toBeEnabled();
      await button.click({ timeout: 10000 }).catch(() => undefined);

      const closed = await currentDialog(page)
        .waitFor({ state: 'hidden', timeout: 4000 })
        .then(() => true)
        .catch(() => false);

      if (closed) {
        return;
      }
    }

    // Final attempt — no catch, so a still-stuck dialog surfaces the error.
    await expect(button).toBeEnabled();
    await button.click();
  };

  await fn(currentDialog(page), closeDialogWith);

  await currentDialog(page).waitFor({ state: 'hidden' });
  await expect(page.locator('dialog[open]')).toHaveCount(0);
}

export async function acceptInvite(page: Page) {
  // InvitePage CTA now reads "Create account and accept" (it generates a new
  // DID agent on the fly); the old "Accept as new user" button is gone. The
  // invite resource is loaded over WS, so under suite-wide load wait longer
  // than the default 5s for the button to appear.
  const acceptBtn = page.getByRole('button', {
    name: 'Create account and accept',
  });
  await expect(acceptBtn).toBeVisible({ timeout: 15000 });
  await acceptBtn.click();

  await inDialog(page, async (dialog, closeDialog) => {
    await expect(
      dialog.getByRole('heading', { name: 'Agent created!' }),
    ).toBeVisible();
    await dialog.getByLabel('Agent Name').fill(`Test User ${timestamp()}`);
    await dialog.getByRole('button', { name: 'Copy to clipboard' }).click();
    await closeDialog('Continue');
  });
}
