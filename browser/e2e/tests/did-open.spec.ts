import { test, expect, type Page } from '@playwright/test';
import {
  before,
  FRONTEND_URL,
  typeInSearch,
  topBarShareButton,
  getCurrentSubject,
} from './test-utils';

/**
 * DID open / share resolve hints — the thin UI layer on top of
 * `resolveDidForOpen`. The helper itself is covered with stubbed fetch in
 * `didResolve.test.ts`; live pkarr / Iroh stay in Rust. Here we only assert
 * that search, Copy link, and show-URL hints actually call into that path.
 *
 * `/iroh-sync` and `/resolve-agent` are intercepted rather than dialled: what
 * is under test is that the UI asks the right endpoints with the right hints.
 */

const NODE = `did:ad:node:${'a'.repeat(64)}`;
const FOREIGN =
  'did:ad:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';

/** Stub pairing; returns a call log so tests can assert dial order. */
async function stubIrohSync(page: Page, body: unknown = { count: 0 }) {
  const calls: Array<{ nodeId: string; drive?: string }> = [];

  await page.route('**/iroh-sync', async route => {
    const post = route.request().postDataJSON() as {
      nodeId?: string;
      drive?: string;
    };
    calls.push({
      nodeId: post.nodeId ?? '',
      drive: post.drive,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  return calls;
}

async function stubResolveAgent(
  page: Page,
  body: unknown = { nodeIds: [NODE] },
) {
  const calls: string[] = [];

  await page.route('**/resolve-agent**', async route => {
    const url = new URL(route.request().url());
    calls.push(url.searchParams.get('agent') ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  return calls;
}

test.describe('DID open from search', () => {
  test.beforeEach(before);

  test('pasting a DID offers Open DID and navigates to it', async ({
    page,
  }) => {
    const drive = await page.evaluate(() => window.store.getDrive());
    expect(drive).toBeTruthy();

    await typeInSearch(page, drive!);
    await expect(page.getByText('Open DID', { exact: true })).toBeVisible();
    await expect(page.getByText(drive!, { exact: true }).first()).toBeVisible();

    await page.getByText('Open DID', { exact: true }).click();
    await page.waitForURL(/\/app\/show/, { timeout: 15000 });

    const subject = await getCurrentSubject(page);
    expect(subject?.split('?')[0]).toBe(drive!.split('?')[0]);
  });
});

test.describe('share link resolve hints', () => {
  test.beforeEach(before);

  test('Copy link embeds agent (and node when the server has one)', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await topBarShareButton(page).click();
    const copy = page.getByRole('button', { name: /Copy link/ });
    await expect(copy).toBeVisible();
    await copy.click();

    await expect(page.getByText(/Link copied/)).toBeVisible({ timeout: 10000 });

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('/app/show?');
    expect(clipboard).toContain('subject=');
    // Signed-in agent is always available after `before` / dev-drive.
    expect(clipboard).toMatch(/agent=did%3Aad%3Aagent%3A|agent=did:ad:agent:/);

    // Node comes from the server's `/server` resource (browser tab has no
    // own node). If the e2e server exposes one, the link must carry it.
    const serverNode = await page.evaluate(async () => {
      const origin = window.store.getServerUrl();
      const res = await fetch(`${origin}/server`);
      const data = (await res.json()) as Record<string, unknown>;
      const nodeProp = 'https://atomicdata.dev/properties/server/nodeId';

      return typeof data[nodeProp] === 'string'
        ? (data[nodeProp] as string)
        : null;
    });

    if (serverNode?.startsWith('did:ad:node:')) {
      expect(clipboard).toContain('node=');
    }
  });
});

test.describe('show URL with resolve hints', () => {
  test.beforeEach(before);

  test('a node hint on /app/show dials /iroh-sync', async ({ page }) => {
    const syncCalls = await stubIrohSync(page);

    await page.goto(
      `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(FOREIGN)}&node=${encodeURIComponent(NODE)}`,
    );

    // DidResolveOnShow fires once the show route mounts. The foreign DID is
    // not local, so it must dial the hinted node (stubbed — no real peer).
    await expect
      .poll(() => syncCalls.length, { timeout: 15000 })
      .toBeGreaterThan(0);

    expect(syncCalls[0].nodeId).toBe(NODE);
    expect(syncCalls[0].drive).toBe(FOREIGN);
  });

  test('an agent hint looks up /resolve-agent then dials', async ({ page }) => {
    const agent =
      'did:ad:agent:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const agentCalls = await stubResolveAgent(page, { nodeIds: [NODE] });
    const syncCalls = await stubIrohSync(page);

    await page.goto(
      `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(FOREIGN)}&agent=${encodeURIComponent(agent)}`,
    );

    await expect
      .poll(() => agentCalls.length, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect(agentCalls[0]).toBe(agent);

    await expect
      .poll(() => syncCalls.length, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect(syncCalls[0].nodeId).toBe(NODE);
  });
});

test.describe('error page known-device fallback', () => {
  test.beforeEach(before);

  test('offers Try known devices and dials seeded peers', async ({ page }) => {
    await page.addInitScript(node => {
      localStorage.setItem(
        'atomic-peers',
        JSON.stringify([{ nodeId: node, label: 'Seeded tablet' }]),
      );
    }, NODE);

    const syncCalls = await stubIrohSync(page);

    // Re-enter via goto so the init script peers are present before boot.
    await page.goto(
      `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(FOREIGN)}`,
    );

    await expect(
      page.getByRole('heading', { name: /Could not open/ }),
    ).toBeVisible({ timeout: 15000 });

    const tryBtn = page.getByRole('button', {
      name: /Try 1 known device/,
    });
    await expect(tryBtn).toBeVisible();
    await tryBtn.click();

    await expect
      .poll(() => syncCalls.length, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect(syncCalls[0].nodeId).toBe(NODE);
  });
});
