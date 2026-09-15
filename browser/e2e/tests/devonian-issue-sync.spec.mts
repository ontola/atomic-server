import { test, expect, type Page, type Locator } from '@playwright/test';
import { mockProxy } from '../../../integrations/localthought/mock-proxy.mjs';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:6747';
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:9883';

test.use({ serviceWorkers: 'block' });

// Exercise the real redirect consent, PKCE redemption, rotating HTTP transport and OPFS.
test('Devonian syncs issue creation, state and comments both ways through the browser proxy', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const proxy = mockProxy({ frontendOrigin: new URL(FRONTEND_URL).origin });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address() as { port: number };
  const proxyOrigin = `http://127.0.0.1:${address.port}`;
  const repository = 'demo/two-way';
  const remote = proxy.github;
  const initial = remote.createIssue(repository, {
    title: 'Created on GitHub',
  });
  remote.createComment(repository, initial.number, {
    body: 'Initial GitHub comment',
  });
  // No AtomicServer WebSocket writes (or Vite HMR reloads) during this journey.
  await page.routeWebSocket('**/*', socket => socket.close());
  const forbidden: string[] = [];
  const requests: string[] = [];
  page.on('request', req => {
    if (req.url().startsWith(`${proxyOrigin}/proxy/`))
      requests.push(req.method());
  });
  // Keep static app assets available even when frontend and AtomicServer share an origin.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());

    if (/^\/(integration-proxy|plugin-run|commit)(\/|$)/.test(url.pathname)) {
      forbidden.push(url.pathname);

      return route.abort();
    }

    if (
      url.origin === new URL(SERVER_URL).origin &&
      url.origin !== new URL(FRONTEND_URL).origin
    )
      return route.abort();

    return route.continue();
  });

  try {
    await page.goto(`${FRONTEND_URL}/app/dev-drive`);
    await page.waitForURL(/app\/show\?subject=/, { timeout: 60000 });
    await page.goto(`${FRONTEND_URL}/app/devonian-demo`);
    await page.getByLabel('Integration proxy URL').fill(proxyOrigin);
    await page.getByLabel('GitHub repository (owner/repo)').fill(repository);
    await page
      .getByRole('button', { name: 'Connect GitHub tracker', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync GitHub Issues with your Atomic Data Hub',
        exact: true,
      })
      .click();

    const sync = async () => {
      const button = page.getByRole('button', {
        name: 'Sync now',
        exact: true,
      });
      await button.click();
      await expect(button).toBeEnabled();
      await expect(page.getByRole('alert')).toHaveCount(0);
    };

    await expect(
      page.getByRole('button', { name: 'Sync now', exact: true }),
    ).toBeVisible();
    expect(page.url()).not.toContain('connection_code');
    await sync();
    const issue = (title: string) =>
      page
        .getByTestId('atomic-issue')
        .filter({ has: page.getByRole('link', { name: title, exact: true }) });
    await expect(issue('Created on GitHub')).toContainText(
      'Initial GitHub comment',
    );

    const text = page.getByLabel('New issue title or comment');
    await text.fill('Created in Atomic');
    await page
      .getByRole('button', { name: 'Create Atomic issue', exact: true })
      .click();
    await expect(issue('Created in Atomic')).toBeVisible();
    await sync();
    const created = remote
      .snapshot(repository)
      .issues.find(i => i.title === 'Created in Atomic');
    expect(created).toBeDefined();
    expect(remote.snapshot(repository).issues).toHaveLength(2);

    await text.fill('Comment from Atomic');
    await issue('Created in Atomic')
      .getByRole('button', { name: 'Add Atomic comment', exact: true })
      .click();
    await issue('Created in Atomic')
      .getByRole('button', { name: 'Close Atomic issue', exact: true })
      .click();
    await sync();
    expect(
      remote.snapshot(repository).issues.find(i => i.number === created!.number)
        ?.state,
    ).toBe('closed');
    expect(
      remote
        .snapshot(repository)
        .comments.filter(c => c.issue_url.endsWith(`/${created!.number}`))
        .map(c => c.body),
    ).toEqual(['Comment from Atomic']);

    remote.updateIssue(repository, created!.number, { state: 'open' });
    remote.createComment(repository, created!.number, {
      body: 'Reply from GitHub',
    });
    remote.updateIssue(repository, initial.number, { state: 'closed' });
    await sync();
    await expect(
      issue('Created in Atomic').getByRole('button', {
        name: 'Close Atomic issue',
        exact: true,
      }),
    ).toBeVisible();
    await expect(issue('Created in Atomic')).toContainText('Reply from GitHub');
    await expect(
      issue('Created on GitHub').getByRole('button', {
        name: 'Reopen Atomic issue',
        exact: true,
      }),
    ).toBeVisible();
    await issue('Created on GitHub')
      .getByRole('button', { name: 'Reopen Atomic issue', exact: true })
      .click();
    await sync();
    expect(
      remote.snapshot(repository).issues.find(i => i.number === initial.number)
        ?.state,
    ).toBe('open');

    const before = remote.snapshot(repository);
    const subjects = await page
      .getByTestId('atomic-issue')
      .getByRole('link')
      .evaluateAll(links =>
        links.map(link => link.getAttribute('href')).sort(),
      );
    await page.reload();
    await sync();
    await expect(page.getByTestId('atomic-issue')).toHaveCount(2);
    await expect(issue('Created in Atomic')).toContainText('Reply from GitHub');
    expect(
      await page
        .getByTestId('atomic-issue')
        .getByRole('link')
        .evaluateAll(links =>
          links.map(link => link.getAttribute('href')).sort(),
        ),
    ).toEqual(subjects);
    expect(remote.snapshot(repository)).toEqual(before);
    expect(requests).toEqual(expect.arrayContaining(['GET', 'POST', 'PATCH']));
    expect(forbidden).toEqual([]);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      proxy.close(error => (error ? reject(error) : resolve())),
    );
  }
});

const column = (page: Page, name: string) =>
  page.getByTestId('kanban-column').filter({ hasText: name });

const cardIn = (col: Locator, title: string) =>
  col.getByTestId('kanban-card').filter({ hasText: title });

/**
 * Drag `source` onto `target` in a way that satisfies @dnd-kit's MouseSensor,
 * which only starts a drag after the pointer moves past a 10px activation
 * distance (see kanban.spec.ts for the same helper).
 */
async function dndDrag(page: Page, source: Locator, target: Locator) {
  const s = await source.boundingBox();
  const t = await target.boundingBox();
  if (!s || !t) throw new Error('drag source/target has no bounding box');
  const sx = s.x + s.width / 2;
  const sy = s.y + s.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 15, sy, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 10 });
  await page.mouse.move(tx, ty + 1, { steps: 2 });
  await page.mouse.up();
}

/**
 * Kanban drag keeps a visual preview until `set()` writes the status tag to
 * the resource. Navigating away (to sync) before that write lands would sync
 * the pre-drag status, so wait for the resource to actually hold it first.
 */
async function waitForCardStatus(page: Page, title: string, col: Locator) {
  const tagSubject = await col
    .getByTestId('kanban-column-body')
    .getAttribute('data-kanban-column-id');
  if (!tagSubject)
    throw new Error('kanban column body has no data-kanban-column-id');
  const nameProp = 'https://atomicdata.dev/properties/name';
  await page.waitForFunction(
    ({ cardTitle, expectedTag, nameProp: prop }) => {
      const store = window.store;
      if (!store) return false;
      for (const resource of store.resources.values()) {
        if (resource.get?.(prop) !== cardTitle) continue;
        for (const [, value] of resource.getEntries?.() ?? []) {
          const subjects = Array.isArray(value) ? value : [];
          if (subjects.includes(expectedTag)) return true;
        }
      }
      return false;
    },
    { cardTitle: title, expectedTag: tagSubject, nameProp },
    { timeout: 30_000 },
  );
}

// Regression test for #1505: the demo's own "Close/Reopen Atomic issue"
// buttons (covered above) write the same status property a real kanban drag
// does, but only a drag through the actual native Kanban view (reached via
// "Open Atomic kanban", as a user would) proves the UI component itself
// wires status changes correctly. Sample mode needs no proxy: the GitHub side
// is an in-browser fixture (see `fixtureTransport` in proxy.mjs).
test('Dragging a card in the real Atomic kanban board closes and reopens the linked GitHub issue', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const title = 'Welcome from GitHub';
  const tryAgain = () =>
    page.getByRole('button', { name: 'Try sample data', exact: true }).click();

  await page.goto(`${FRONTEND_URL}/app/dev-drive`);
  await page.waitForURL(/app\/show\?subject=/, { timeout: 60000 });
  await page.goto(`${FRONTEND_URL}/app/devonian-demo`);
  await tryAgain();

  const openKanban = page.getByRole('link', {
    name: 'Open Atomic kanban',
    exact: true,
  });
  await expect(openKanban).toBeVisible();
  const demoIssue = page
    .getByTestId('atomic-issue')
    .filter({ hasText: title });
  await expect(demoIssue).toContainText('Todo');
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Drag the card from Todo to Done in the real, native kanban board.
  await openKanban.click();
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  const todo = column(page, 'todo');
  const doneColumn = column(page, 'done');
  await expect(cardIn(todo, title)).toBeVisible();
  await dndDrag(
    page,
    cardIn(todo, title),
    doneColumn.getByTestId('kanban-column-body'),
  );
  await expect(cardIn(doneColumn, title)).toBeVisible();
  await expect(cardIn(todo, title)).toHaveCount(0);
  await waitForCardStatus(page, title, doneColumn);

  // Back on the demo page, syncing must have picked up the drag as a genuine
  // local status change and closed the GitHub-side (fixture) issue.
  await page.goto(`${FRONTEND_URL}/app/devonian-demo`);
  await tryAgain();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(demoIssue).toContainText('Done');
  await expect(
    page.getByText('closed', { exact: true }).first(),
  ).toBeVisible();

  // Drag it back to Todo — the fixture issue must reopen.
  await openKanban.click();
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await dndDrag(
    page,
    cardIn(doneColumn, title),
    todo.getByTestId('kanban-column-body'),
  );
  await expect(cardIn(todo, title)).toBeVisible();
  await waitForCardStatus(page, title, todo);

  await page.goto(`${FRONTEND_URL}/app/devonian-demo`);
  await tryAgain();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(demoIssue).toContainText('Todo');
  await expect(page.getByText('open', { exact: true }).first()).toBeVisible();
});
