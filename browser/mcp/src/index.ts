#!/usr/bin/env node
/**
 * `atomic-mcp`: an MCP server over stdio that reads and edits Atomic Data as
 * the Agent whose secret it is given. See ../README.md for client setup.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Agent, Store, enableLoro } from '@tomic/lib';
import { createAtomicMcpServer } from './server.js';

const serverUrl = process.env.ATOMIC_SERVER_URL;
const secret = process.env.ATOMIC_AGENT_SECRET;

// stdout is the protocol channel: everything human-readable goes to stderr,
// including the library's own console logging.
console.log = console.info = console.debug = console.error;

const log = (message: string) =>
  process.stderr.write(`[atomic-mcp] ${message}\n`);

if (!serverUrl) {
  log(
    'Set ATOMIC_SERVER_URL to the server your drives live on, e.g. https://atomicdata.dev',
  );
  process.exit(1);
}

const agent = secret ? await Agent.fromSecret(secret) : undefined;
const drive =
  process.env.ATOMIC_DRIVE ?? agent?.initialDrive ?? agent?.privateDrive;

if (!drive) {
  log(
    'Set ATOMIC_DRIVE to a drive subject, or ATOMIC_AGENT_SECRET to your agent secret (in the app: /app/agent, Account recovery).',
  );
  process.exit(1);
}

// Resources arrive as Loro snapshots; without Loro they never finish loading.
await enableLoro();

const store = new Store({ serverUrl, agent });
store.setServerConnected(true);

const mcp = createAtomicMcpServer({
  store,
  drive,
  allowWrites: !!agent && process.env.ATOMIC_READ_ONLY !== 'true',
});

await mcp.connect(new StdioServerTransport());
log(
  `Connected to ${serverUrl} as ${agent?.subject ?? 'a public reader'}, default drive ${drive}`,
);
