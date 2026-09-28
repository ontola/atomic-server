#!/usr/bin/env node
/**
 * `atomic-mcp`: an MCP server over stdio that reads and edits Atomic Data.
 *
 * By default it signs as its own Agent, a key made on this machine that the
 * person allows from the app (`atomic-mcp connect`). `ATOMIC_AGENT_SECRET`
 * still works for scripts and CI. See ../README.md for client setup.
 */
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  Agent,
  Store,
  connectAgentUrl,
  enableLoro,
  publishAgentName,
  sharedWith,
  waitForGrant,
} from '@tomic/lib';
import { loadOrCreateLocalAgent } from '@tomic/lib/node';
import { createAtomicMcpServer, type Access } from './server.js';

// stdout is the protocol channel: everything human-readable goes to stderr,
// including the library's own console logging.
console.log = console.info = console.debug = console.error;

const log = (message: string) =>
  process.stderr.write(`[atomic-mcp] ${message}\n`);

const command = process.argv[2];
const serverUrl = process.env.ATOMIC_SERVER_URL;
const appUrl = process.env.ATOMIC_APP_URL ?? serverUrl;
const clientName =
  process.env.ATOMIC_CLIENT_NAME ?? `AI assistant on ${hostname()}`;

if (!serverUrl || !appUrl) {
  log(
    'Set ATOMIC_SERVER_URL to the server your drives live on, e.g. https://atomicdata.dev',
  );
  process.exit(1);
}

// Resources arrive as Loro snapshots; without Loro they never finish loading.
await enableLoro();

const secret = process.env.ATOMIC_AGENT_SECRET;
const local = secret
  ? undefined
  : await loadOrCreateLocalAgent('atomic-mcp', serverUrl);
const agent = secret ? await Agent.fromSecret(secret) : local!.agent;

const store = new Store({ serverUrl, agent });
store.setServerConnected(true);

const link = local
  ? connectAgentUrl(appUrl, { publicKey: local.publicKey, name: clientName })
  : undefined;

if (local) {
  // Best effort: the grant works without it, the person just sees a key.
  await publishAgentName(store, clientName).catch(e =>
    log(`Could not publish this key's name: ${e}`),
  );
}

/** What this agent may reach. A local key needs the person's approval. */
async function resolveAccess(): Promise<Access> {
  if (!local) {
    const drive =
      process.env.ATOMIC_DRIVE ?? agent.initialDrive ?? agent.privateDrive;

    if (!drive) {
      throw new Error(
        'Set ATOMIC_DRIVE to a drive subject: this secret names no drive.',
      );
    }

    return { drive, targets: [drive] };
  }

  const targets = await sharedWith(store, agent.subject!);

  if (targets.length === 0) {
    throw new Error(
      `This connection has no access to any Atomic data yet. Ask the person to open this link, choose what to share and click Allow, then try again: ${link}`,
    );
  }

  const drive =
    process.env.ATOMIC_DRIVE && targets.includes(process.env.ATOMIC_DRIVE)
      ? process.env.ATOMIC_DRIVE
      : targets[0];

  return { drive, targets: [drive, ...targets.filter(t => t !== drive)] };
}

function openInBrowser(url: string) {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer'
        : 'xdg-open';

  try {
    spawn(opener, [url], { detached: true, stdio: 'ignore' })
      .on('error', () => undefined)
      .unref();
  } catch {
    // No browser to open: the printed link is enough.
  }
}

if (command === 'connect') {
  if (!local || !link) {
    log('ATOMIC_AGENT_SECRET is set, so there is nothing to connect.');
    process.exit(0);
  }

  const already = await sharedWith(store, agent.subject!);

  if (already.length === 0) {
    process.stderr.write(
      `\nOpen this link to let "${clientName}" use your Atomic data:\n\n  ${link}\n\nWaiting for you to click Allow...\n`,
    );
    openInBrowser(link);

    try {
      await waitForGrant(store, agent.subject!);
    } catch {
      log('Gave up waiting. Run this again when you are ready.');
      process.exit(1);
    }
  }

  process.stderr.write(
    `\nConnected. This machine's key is ${agent.subject}, stored in ${local.path}.\nYou can revoke it any time in the app under your account settings.\n`,
  );
  process.exit(0);
}

const mcp = createAtomicMcpServer({
  store,
  access: resolveAccess,
  allowWrites: process.env.ATOMIC_READ_ONLY !== 'true',
});

await mcp.connect(new StdioServerTransport());
log(`Connected to ${serverUrl} as ${agent.subject}`);
