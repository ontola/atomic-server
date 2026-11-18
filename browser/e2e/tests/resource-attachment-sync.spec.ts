import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  before,
  FRONTEND_URL,
  getDevDriveSecret,
  openSubject,
  signIn,
  waitForClientDbFlush,
  waitForClientDbReady,
  waitForServerConnected,
  waitForSynced,
} from './test-utils';
import { SIGNALING, signalingRoom } from './resource-peer-test-utils';

const CONTENT =
  'Actual attachment bytes, independently verified from resource details.\n';
const TITLE = 'Attachment evidence';

function indicatorFor(page: Page) {
  return page
    .locator('section')
    .filter({
      has: page.getByRole('heading', { name: 'Resources', exact: true }),
    })
    .getByRole('button', { name: /^Copies and sync for Attachment evidence:/ });
}

/** Saving a File's real metadata without storing its bytes represents the normal
 * gap during a download. No receipt is injected or mocked. */
async function createMissingAttachment(page: Page) {
  return page.evaluate(
    async ({ content, title }) => {
      const store = window.store;
      const db = store.getClientDb()!;
      const bytes = new TextEncoder().encode(content);
      const hash = Array.from(await db.blake3Hash(bytes), byte =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const file = await store.newResource({
        parent: store.getDrive(),
        isA: 'https://atomicdata.dev/classes/File',
        propVals: {
          'https://atomicdata.dev/properties/filename': 'evidence.txt',
          'https://atomicdata.dev/properties/mimetype': 'text/plain',
          'https://atomicdata.dev/properties/filesize': bytes.length,
          'https://atomicdata.dev/properties/internalId': hash,
          'https://atomicdata.dev/properties/downloadURL': `${store.getServerUrl()}/download/files/${hash}`,
          'https://atomicdata.dev/properties/blob': `atomic:blob:${hash}`,
        },
      });
      await file.save();
      const folder = await store.newResource({
        parent: store.getDrive(),
        isA: 'https://atomicdata.dev/classes/Folder',
        propVals: {
          'https://atomicdata.dev/properties/name': title,
          'https://atomicdata.dev/properties/attachments': [file.subject],
        },
      });
      await folder.save();

      return { subject: folder.subject, file: file.subject, hash };
    },
    { content: CONTENT, title: TITLE },
  );
}

async function storeBytes(page: Page, content = CONTENT) {
  await page.evaluate(async text => {
    const db = window.store.getClientDb()!;
    const bytes = new TextEncoder().encode(text);
    await db.putBlob(await db.blake3Hash(bytes), bytes);
  }, content);
  await waitForClientDbFlush(page, { required: true });
}

async function contents(page: Page, subject: string) {
  return page.evaluate(
    target =>
      window.store.getResourceAttachmentSyncStatus(
        window.store.getResourceLoading(target),
      ),
    subject,
  );
}

test.beforeEach(before);

test('resource details can sync before exact attachment bytes, and replacement invalidates contents', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1300 });
  // Hold real byte downloads during the intentional metadata-only gap. All
  // authentication, resource commits, and evidence queries still reach the
  // server. Release downloads only after the actual bytes have been uploaded.
  let holdBlobDownloads = true;
  const pendingDownloads: Array<() => void> = [];
  await page.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      if (
        holdBlobDownloads &&
        typeof message !== 'string' &&
        message[0] === 0x34
      ) {
        pendingDownloads.push(() => server.send(message));
      } else server.send(message);
    });
    server.onMessage(message => socket.send(message));
  });

  const releaseDownloads = () => {
    holdBlobDownloads = false;
    for (const release of pendingDownloads.splice(0)) release();
  };

  // WebSocket routing applies to new connections only.
  await page.reload();
  await waitForClientDbReady(page);
  await waitForServerConnected(page);
  const target = await createMissingAttachment(page);
  await waitForSynced(page);
  const indicator = indicatorFor(page);
  await expect(indicator).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        subject =>
          window.store.getResourceSyncStatus(
            window.store.getResourceLoading(subject),
          ).server.state,
        target.subject,
      ),
    )
    .toBe('confirmed');
  await expect
    .poll(() => contents(page, target.subject))
    .toMatchObject({
      required: true,
      local: { state: 'unknown' },
      server: { state: 'unknown' },
    });
  await storeBytes(page);

  try {
    await expect(indicator).toHaveAttribute(
      'data-content-local-state',
      'confirmed',
    );
  } catch (error) {
    const diagnostics = await page.evaluate(async fixtureTarget => {
      const store = window.store;
      const db = store.getClientDb()!;
      const resource = await store.getResource(fixtureTarget.subject);
      const file = await store.getResource(fixtureTarget.file);
      const hash = new Uint8Array(
        fixtureTarget.hash.match(/../g)!.map(pair => Number.parseInt(pair, 16)),
      );
      const blob = await db.getBlob(hash);

      return {
        status: store.getResourceAttachmentSyncStatus(resource),
        evidence: await db.getResourceAttachmentEvidence?.([
          fixtureTarget.subject,
          fixtureTarget.file,
        ]),
        file: {
          subject: file.subject,
          properties: file.getLoroDoc()!.getMap('properties').toJSON(),
        },
        resource: {
          subject: resource.subject,
          properties: resource.getLoroDoc()!.getMap('properties').toJSON(),
        },
        bytes: blob ? Array.from(blob) : null,
      };
    }, target);
    await test.info().attach('attachment-evidence-diagnostics.json', {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: 'application/json',
    });
    throw error;
  }

  expect((await contents(page, target.subject)).server.state).not.toBe(
    'confirmed',
  );
  await page.evaluate(
    async subject =>
      window.store.maybePushBlobForResource(
        await window.store.getResource(subject),
      ),
    target.file,
  );
  releaseDownloads();
  await expect(indicator).toHaveAttribute(
    'data-content-server-state',
    'confirmed',
  );
  await indicator.click();
  const dialog = page.getByRole('dialog', { name: 'Copies & sync' });
  await expect(dialog).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: test.info().outputPath('attachment-copies-desktop.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: 'Close copies and sync' }).click();

  await page.evaluate(async subject => {
    const file = await window.store.getResource(subject);
    await file.set(
      'https://atomicdata.dev/properties/filename',
      'renamed.txt',
      false,
    );
    await file.save();
  }, target.file);
  await expect(indicator).toHaveAttribute(
    'data-content-local-state',
    'confirmed',
  );
  await expect(indicator).toHaveAttribute(
    'data-content-server-state',
    'confirmed',
  );
  await waitForSynced(page);
  await page.reload();
  await waitForClientDbReady(page);
  await expect(indicator).toHaveAttribute(
    'data-content-local-state',
    'confirmed',
  );
  await expect(indicator).toHaveAttribute(
    'data-content-server-state',
    'confirmed',
  );

  holdBlobDownloads = true;
  const replacement = `${CONTENT}Replaced content.`;
  await page.evaluate(
    async ({ subject, text }) => {
      const store = window.store;
      const hash = Array.from(
        await store.getClientDb()!.blake3Hash(new TextEncoder().encode(text)),
        byte => byte.toString(16).padStart(2, '0'),
      ).join('');
      const file = await store.getResource(subject);
      await file.set(
        'https://atomicdata.dev/properties/blob',
        `atomic:blob:${hash}`,
        false,
      );
      await file.set(
        'https://atomicdata.dev/properties/internalId',
        hash,
        false,
      );
      await file.set(
        'https://atomicdata.dev/properties/filesize',
        new TextEncoder().encode(text).length,
        false,
      );
      await file.save();
    },
    { subject: target.file, text: replacement },
  );
  await waitForSynced(page);
  await expect(indicator).not.toHaveAttribute(
    'data-content-local-state',
    'confirmed',
  );
  await expect(indicator).not.toHaveAttribute(
    'data-content-server-state',
    'confirmed',
  );
  await storeBytes(page, replacement);
  await page.evaluate(
    async subject =>
      window.store.maybePushBlobForResource(
        await window.store.getResource(subject),
      ),
    target.file,
  );
  releaseDownloads();
  await expect(indicator).toHaveAttribute(
    'data-content-local-state',
    'confirmed',
  );
  await expect(indicator).toHaveAttribute(
    'data-content-server-state',
    'confirmed',
  );
  await page
    .getByRole('button', { name: 'Show / hide sidebar', exact: false })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await indicator.click();
  await expect(dialog).toHaveCSS('opacity', '1');
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await page.screenshot({
    path: test.info().outputPath('attachment-copies-mobile.png'),
    animations: 'disabled',
  });
});

async function makeLocal(page: Page, drive: string) {
  await waitForClientDbReady(page);
  await waitForServerConnected(page);
  await waitForSynced(page);
  await expect
    .poll(
      () =>
        page.evaluate(async subject => {
          try {
            await window.store.makeDriveLocal(subject);

            return true;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message ===
                'Wait for changes to finish syncing before disconnecting.'
            )
              return false;
            throw error;
          }
        }, drive),
      { timeout: 20_000 },
    )
    .toBe(true);
  await waitForClientDbFlush(page, { required: true });
}

test('real WebRTC peer confirmation includes received attachment bytes rather than details alone', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1300 });
  const relay = signalingRoom();
  await relay.install(context);
  const secret = await getDevDriveSecret(page);
  const drive = await page.evaluate(() => window.store.getDrive()!);
  const remoteContext = await browser.newContext();

  try {
    await relay.install(remoteContext);
    const remote = await remoteContext.newPage();
    await remote.goto(`${FRONTEND_URL}/app/welcome`);
    await signIn(remote, secret);
    await openSubject(remote, drive);
    for (const current of [page, remote]) await makeLocal(current, drive);
    for (const current of [page, remote])
      await current.evaluate(
        url => localStorage.setItem('peer-signaling-url', url),
        SIGNALING,
      );
    await expect.poll(relay.memberCount, { timeout: 20_000 }).toBe(2);
    const target = await createMissingAttachment(page);
    const indicator = indicatorFor(page);
    await expect(indicator).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(
            subject =>
              window.store.getResourcePeerSyncStatus(
                window.store.getResourceLoading(subject),
              ).confirmedCount,
            target.subject,
          ),
        { timeout: 30_000 },
      )
      .toBe(1);
    expect(
      (await contents(page, target.subject)).peers.every(
        peer => peer.state !== 'confirmed',
      ),
    ).toBe(true);
    await storeBytes(page);
    // Existing blob delivery is triggered by an incoming File update. A real
    // rename publishes that update after the bytes become available.
    await page.evaluate(async subject => {
      const file = await window.store.getResource(subject);
      await file.set(
        'https://atomicdata.dev/properties/filename',
        'received.txt',
        false,
      );
      await file.save();
    }, target.file);
    await expect
      .poll(() => contents(page, target.subject), { timeout: 30_000 })
      .toMatchObject({
        local: { state: 'confirmed' },
        server: { state: 'not-configured' },
      });
    await expect
      .poll(
        async () =>
          (await contents(page, target.subject)).peers.filter(
            peer => peer.state === 'confirmed',
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    const received = await remote.evaluate(async hash => {
      const bytes = new Uint8Array(
        hash.match(/../g)!.map(pair => Number.parseInt(pair, 16)),
      );
      const data = await window.store.getClientDb()!.getBlob(bytes);

      return data ? new TextDecoder().decode(data) : null;
    }, target.hash);
    expect(received).toBe(CONTENT);
    const serverSubjects = await page.evaluate(
      async subject =>
        (
          await window.store.getDefaultWebSocket()!.driveInventory(subject, '')
        ).map(item => item.subject),
      drive,
    );
    expect(serverSubjects).not.toContain(target.subject);
    expect(serverSubjects).not.toContain(target.file);
    await indicator.click();
    const dialog = page.getByRole('dialog', { name: 'Copies & sync' });
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(dialog.getByTestId('resource-peer-copies')).toHaveAttribute(
      'data-confirmed-count',
      '1',
    );
    await page.screenshot({
      path: test.info().outputPath('attachment-peer-copies.png'),
      animations: 'disabled',
    });
    await remoteContext.close();
    // Match the existing real-peer journey's transport departure budget.
    // A closed signaling socket alone does not end an authenticated data channel.
    await expect
      .poll(
        () =>
          page.evaluate(subject => {
            const store = window.store;
            const resource = store.getResourceLoading(subject);

            return {
              metadata: store.getResourcePeerSyncStatus(resource),
              contents: store.getResourceAttachmentSyncStatus(resource).peers,
            };
          }, target.subject),
        { timeout: 20_000 },
      )
      .toMatchObject({
        metadata: {
          state: 'unknown',
          connectedCount: 0,
          confirmedCount: 0,
          peers: [],
        },
        contents: [],
      });
  } finally {
    relay.dispose();
    await remoteContext.close();
  }
});
