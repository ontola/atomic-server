/* eslint-disable no-shadow -- Playwright callbacks run in a separate browser realm. */
// Real Chromium worker/OPFS, HTTP and WebSocket against an isolated API server.
// Uses source modules through Vite; no embedded application bundle is involved.
// node browser/e2e/scripts/verify-server-receipts.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer as createVite } from 'vite';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'atomic-browser-receipts-'));
const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const serverUrl = `http://localhost:${port}`;
const child = spawn(
  process.env.ATOMIC_TEST_SERVER ?? join(root, 'target/debug/atomic-server'),
  [],
  {
    cwd: root,
    env: {
      ...process.env,
      ATOMIC_PORT: String(port),
      ATOMIC_DOMAIN: 'localhost',
      ATOMIC_INITIALIZE: 'true',
      ATOMIC_DATA_DIR: join(temporary, 'data'),
      ATOMIC_CONFIG_DIR: join(temporary, 'config'),
      ATOMIC_CACHE_DIR: join(temporary, 'cache'),
      RUST_LOG: 'warn',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
let serverErrors = '';
child.stderr.on('data', data => (serverErrors += String(data)));
const vite = await createVite({
  configFile: false,
  root,
  cacheDir: join(root, 'browser/node_modules/.vite/server-receipts'),
  optimizeDeps: { entries: ['browser/e2e/scripts/server-receipts-harness.ts'] },
  server: { host: '127.0.0.1', port: 0 },
});
vite.middlewares.use((req, res, next) => {
  if (req.url !== '/app/dev-drive') return next();
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Browser server receipt acceptance</title>');
});
let browser;
const timeout = setTimeout(() => {
  void browser?.close();
  child.kill('SIGTERM');
}, 180_000);

try {
  const deadline = Date.now() + 90_000;
  let ready = false;

  while (!ready && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(serverErrors);

    try {
      const response = await fetch(serverUrl);
      ready = response.ok;
    } catch {}

    if (!ready) await delay(100);
  }

  assert.ok(ready, `API server readiness failed: ${serverErrors}`);
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext();
  const errors = [];

  const open = async secret => {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/app/dev-drive`);
    await page.evaluate(
      async ({ serverUrl, secret }) => {
        window.harness =
          await import('/browser/e2e/scripts/server-receipts-harness.ts');
        window.state = await window.harness.openClient(serverUrl, secret);
      },
      { serverUrl, secret },
    );

    return page;
  };

  let page = await open();
  await page.waitForFunction(() => window.state.store.serverConnected);
  const seed = await page.evaluate(async () => {
    const { store, db } = window.state;
    const drive = await store.createDrive('Browser receipt acceptance');
    store.setDrive(drive.subject);
    await db.flush();

    return {
      drive: drive.subject,
      secret: window.state.secret,
      identity: await db.getReplicaIdentity(drive.subject),
    };
  });
  assert.match(seed.identity.storageId, /^[0-9a-f]{64}$/);
  const queued = await page.evaluate(async drive => {
    const { store, db } = window.state;
    localStorage.setItem('ws-disconnected', '1');
    store.disconnect();
    store.setServerConnected(false);
    const resource = await store.newResource({
      parent: drive,
      propVals: {
        [window.harness.core.properties.name]: 'Saved offline before close',
      },
    });
    const status = await resource.save();
    await store.outbox.flush();
    await db.flush();

    const stored = await db.getResourceWithSnapshot(resource.subject);

    return {
      subject: resource.subject,
      status,
      version: window.harness.snapshotVersion(stored.snapshot),
    };
  }, seed.drive);
  assert.equal(queued.status, 'offline');
  await page.close();
  // Reopen the actual persisted database while offline, then let ordinary
  // Store.reconnect perform auth, cold outbox draining, and reconciliation.
  page = await open(seed.secret);
  const identity = await page.evaluate(async drive => {
    const { store, db } = window.state;
    store.setDrive(drive);
    localStorage.removeItem('ws-disconnected');
    await store.reconnect();

    return db.getReplicaIdentity(drive);
  }, seed.drive);
  assert.deepEqual(identity, seed.identity);
  await page.waitForFunction(
    ({ subject, version }) =>
      window.state.receipts.some(
        receipt =>
          receipt.observation.barrier?.subject === subject &&
          window.harness.receiptCovers(receipt, version),
      ),
    queued,
    { timeout: 45_000 },
  );
  const first = await page.evaluate(
    ({ subject, version }) =>
      window.state.receipts.find(
        receipt =>
          receipt.observation.barrier?.subject === subject &&
          window.harness.receiptCovers(receipt, version),
      ),
    queued,
  );
  assert.deepEqual(first.source, seed.identity);
  assert.notEqual(first.observation.replica.storageId, first.source.storageId);
  assert.equal(first.observation.barrier.state, 'completed');
  assert.equal(first.observation.barrier.storage, 'persistent');
  console.info(
    'PASS offline OPFS close/reopen automatically drains and produces remote storage evidence',
  );

  // The second Store is an actual independent HTTP client. The observed Store
  // only imports its server state and never saves or manually requests proof.
  const imported = await page.evaluate(
    async ({ drive, serverUrl }) => {
      const { store, agent, db } = window.state;
      const writer = new window.harness.Store({ serverUrl, agent });

      try {
        await new Promise(resolve => {
          const timer = setInterval(() => {
            if (writer.serverConnected) {
              clearInterval(timer);
              resolve();
            }
          }, 20);
        });
        const resource = await writer.newResource({
          parent: drive,
          propVals: {
            [window.harness.core.properties.name]:
              'Imported after initial sync',
          },
        });
        await resource.save();
        await store.fetchResourceFromServer(resource.subject);
        await db.flush();

        const stored = await db.getResourceWithSnapshot(resource.subject);

        return {
          subject: resource.subject,
          version: window.harness.snapshotVersion(stored.snapshot),
        };
      } finally {
        writer.disconnect();
        writer.setServerConnected(false);
      }
    },
    { drive: seed.drive, serverUrl },
  );
  await page.waitForFunction(
    ({ subject, version }) =>
      window.state.receipts.some(
        receipt =>
          receipt.observation.barrier?.subject === subject &&
          receipt.transport === 'websocket' &&
          window.harness.receiptCovers(receipt, version),
      ),
    imported,
    { timeout: 45_000 },
  );
  console.info(
    'PASS newly imported OPFS state produces evidence without a local save or reconnect',
  );

  const before = await page.evaluate(
    ({ subject, version }) =>
      window.state.receipts.find(
        receipt =>
          receipt.observation.barrier?.subject === subject &&
          receipt.transport === 'websocket' &&
          window.harness.receiptCovers(receipt, version),
      ),
    imported,
  );
  const exactStoredTarget = await page.evaluate(
    receipt =>
      window.state.captured.some(
        item =>
          item.subject === receipt.observation.barrier.subject &&
          JSON.stringify(item.version) ===
            JSON.stringify(window.harness.receiptVersion(receipt)),
      ),
    before,
  );
  assert.ok(
    exactStoredTarget,
    'receipt must name an actually captured applied stored version',
  );
  await page.evaluate(() => window.state.store.reconnect());
  await page.waitForFunction(
    ({ subject, previous }) =>
      window.state.receipts.some(
        receipt =>
          receipt.observation.barrier?.subject === subject &&
          receipt.connectionId !== previous,
      ),
    { subject: imported.subject, previous: before.connectionId },
    { timeout: 45_000 },
  );
  const after = await page.evaluate(
    ({ subject, previous }) =>
      window.state.receipts.find(
        receipt =>
          receipt.observation.barrier?.subject === subject &&
          receipt.connectionId !== previous,
      ),
    { subject: imported.subject, previous: before.connectionId },
  );
  assert.deepEqual(after.source, seed.identity);
  assert.deepEqual(after.observation.replica, before.observation.replica);
  const activeConnection = await page.evaluate(
    serverUrl =>
      window.state.store
        .getWebSocketForEndpoint(`${serverUrl}/commit`)
        ?.getStorageReceiptSession(),
    serverUrl,
  );
  assert.equal(after.connectionId, activeConnection);
  assert.deepEqual(errors, []);
  console.info(
    'PASS reconnect produces fresh connection evidence with stable persistent identities',
  );
} finally {
  clearTimeout(timeout);
  await browser?.close();
  await vite.close();
  child.kill('SIGTERM');
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000).unref();
  });
  await rm(temporary, { recursive: true, force: true });
}
