/* eslint-disable no-shadow -- Playwright callbacks run in a separate browser realm. */
// Real authenticated WebRTC + OPFS. Only discovery/SDP routing is simulated;
// no AtomicServer data process, manual receipt probe, or persistence stub.
// Run after building this checkout's WASM:
// node browser/e2e/scripts/verify-peer-receipts.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const signalingUrl = 'wss://signalling.invalid/webrtc-signal';
const rooms = new Map();
const vite = await createServer({
  configFile: false,
  root,
  cacheDir: join(root, 'browser/node_modules/.vite/peer-receipts'),
  optimizeDeps: { entries: ['browser/e2e/scripts/peer-sync-harness.ts'] },
  server: { host: '127.0.0.1', port: 0 },
});
vite.middlewares.use((req, res, next) => {
  if (req.url !== '/') return next();
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Peer receipt acceptance</title>');
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch();
const deadline = setTimeout(() => browser.close(), 120000);

try {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);

  for (const context of contexts) {
    await context.routeWebSocket('**/webrtc-signal', socket => {
      let room;
      let peer;
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));

        if (message.type === 'join') {
          room = rooms.get(message.room) ?? new Map();
          rooms.set(message.room, room);
          peer = message.peer;
          socket.send(
            JSON.stringify({
              type: 'joined',
              peers: [...room.keys()],
              iceServers: [],
            }),
          );
          for (const other of room.values())
            other.send(JSON.stringify({ type: 'peer', peer }));
          room.set(peer, socket);
        } else if (room && peer && ['offer', 'answer'].includes(message.type)) {
          room.get(message.to)?.send(
            JSON.stringify({
              type: message.type,
              from: peer,
              sdp: message.sdp,
            }),
          );
        }
      });
      socket.onClose(() => {
        if (!room || !peer) return;
        room.delete(peer);
        for (const other of room.values())
          other.send(JSON.stringify({ type: 'left', peer }));
      });
    });
  }

  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [a, b] = pages;
  const errors = [];

  const open = async (page, secret) => {
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);

    return page.evaluate(async secret => {
      window.harness =
        await import('/browser/e2e/scripts/peer-sync-harness.ts');
      window.state = await window.harness.openPeer(secret);
      window.receipts = [];

      return { secret: window.state.secret, agent: window.state.agent.subject };
    }, secret);
  };

  const owners = await Promise.all(pages.map(page => open(page)));
  const drive = await a.evaluate(() =>
    window.harness.createDrive(window.state.store),
  );
  await a.evaluate(
    async ({ drive, agents }) => {
      const resource = window.state.store.resources.get(drive);

      for (const permission of ['read', 'write']) {
        await resource.set(
          `https://atomicdata.dev/properties/${permission}`,
          agents,
          false,
        );
      }

      await resource.save();
    },
    { drive, agents: owners.map(owner => owner.agent) },
  );
  const room = randomBytes(32).toString('hex');
  const connect = async (page, expectedPeer) =>
    page.evaluate(
      ({ drive, room, expectedPeer, signalingUrl }) => {
        const { store } = window.state;
        store.registerLocalOnlyDrive(drive);
        store.setDrive(drive);
        window.link = new window.harness.BrowserPeerSync(store, {
          drive,
          room,
          expectedPeer,
          signalingUrl,
          iceServers: [],
          onStatus: status => console.log('PEER_STATUS', status),
          onReplicaReceipt: receipt => window.receipts.push(receipt),
        });
      },
      { drive, room, expectedPeer, signalingUrl },
    );
  await Promise.all([connect(a, owners[1].agent), connect(b, owners[0].agent)]);
  await b.waitForFunction(
    drive =>
      window.state.store.resources
        .get(drive)
        ?.get('https://atomicdata.dev/properties/name') === 'Peer workspace',
    drive,
    { timeout: 30000 },
  );

  const saved = await a.evaluate(async drive => {
    const resource = await window.state.store.newResource({
      isA: 'https://atomicdata.dev/classes/Folder',
      parent: drive,
      propVals: {
        'https://atomicdata.dev/properties/name': 'Receipt version one',
      },
    });
    const first = await resource.saveWithReceipt();
    await resource.set(
      'https://atomicdata.dev/properties/name',
      'Receipt version two',
      false,
    );
    const second = await resource.saveWithReceipt();

    return { subject: resource.subject, first, second };
  }, drive);
  assert.ok(saved.first.local?.version);
  assert.ok(saved.second.local?.version);
  assert.notEqual(saved.first.local.version, saved.second.local.version);
  await a.waitForFunction(
    ({ subject, versions }) =>
      versions.every(version =>
        window.receipts.some(
          receipt =>
            receipt.observation.barrier?.subject === subject &&
            receipt.observation.barrier?.version === version,
        ),
      ),
    {
      subject: saved.subject,
      versions: [saved.first.local.version, saved.second.local.version],
    },
    { timeout: 30000 },
  );
  const emitted = await a.evaluate(
    subject =>
      window.receipts.filter(
        receipt => receipt.observation.barrier?.subject === subject,
      ),
    saved.subject,
  );
  assert.ok(emitted.every(receipt => receipt.peerAgent === owners[1].agent));
  assert.ok(emitted.every(receipt => receipt.drive === drive));
  const source = await a.evaluate(
    drive => window.state.db.getReplicaIdentity(drive),
    drive,
  );
  const destination = await b.evaluate(
    drive => window.state.db.getReplicaIdentity(drive),
    drive,
  );
  assert.notEqual(source.storageId, destination.storageId);
  assert.deepEqual(emitted[0].source, source);
  assert.deepEqual(emitted[0].observation.replica, destination);
  const assessment = await a.evaluate(async subject => {
    const { evaluateReplicaEvidence } =
      await import('/browser/lib/src/index.js');
    const receipt = window.receipts.find(
      receipt => receipt.observation.barrier?.subject === subject,
    );

    return evaluateReplicaEvidence(
      {
        subject,
        version: receipt.observation.barrier.version,
        source: receipt.source,
        scope: 'device',
      },
      [receipt.observation],
    ).status;
  }, saved.subject);
  assert.equal(assessment, 'unknown');
  console.log(
    'PASS automatic authenticated receipts for two exact save versions; no inferred device independence',
  );

  // Same browser storage partition: a follower must see the same identity.
  const follower = await contexts[1].newPage();
  await open(follower, owners[1].secret);
  assert.deepEqual(
    await follower.evaluate(
      drive => window.state.db.getReplicaIdentity(drive),
      drive,
    ),
    destination,
  );
  await b.close();
  assert.deepEqual(
    await follower.evaluate(
      drive => window.state.db.getReplicaIdentity(drive),
      drive,
    ),
    destination,
  );
  const snapshot = await follower.evaluate(
    subject => window.state.db.getResourceWithSnapshot(subject),
    saved.subject,
  );
  assert.ok(snapshot.snapshot);
  assert.ok(JSON.stringify(snapshot).includes('Receipt version two'));
  console.log(
    'PASS shared-tab storage identity and leader handoff retain the receipted snapshot',
  );

  // Close the final owner, then reopen the actual OPFS database.
  await follower.close();
  const reopened = await contexts[1].newPage();
  await open(reopened, owners[1].secret);
  assert.deepEqual(
    await reopened.evaluate(
      drive => window.state.db.getReplicaIdentity(drive),
      drive,
    ),
    destination,
  );
  const restored = await reopened.evaluate(
    subject => window.state.db.getResourceWithSnapshot(subject),
    saved.subject,
  );
  assert.ok(restored.snapshot);
  assert.ok(JSON.stringify(restored).includes('Receipt version two'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS OPFS reopen preserves storage identity and the covered resource',
  );
} finally {
  clearTimeout(deadline);
  await browser.close();
  await vite.close();
}
