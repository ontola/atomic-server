import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Agent, JSCryptoProvider, agentSubject } from '@tomic/lib';

/**
 * This machine's own Agent for one server: a keypair made here, kept in the
 * user's config directory, never shown to anyone. The person grants it rights
 * from the app (`connectAgentUrl` in @tomic/lib), so their
 * own secret never leaves the app and every edit is signed as this client.
 */
export interface LocalAgent {
  agent: Agent;
  publicKey: string;
  /** Where the key lives on disk. */
  path: string;
}

interface StoredKey {
  privateKey: string;
  publicKey: string;
}

const configDir = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'atomic-mcp');

/** One key per server, so a grant on one server says nothing about another. */
export const keyPath = (serverUrl: string) =>
  join(configDir(), `${new URL(serverUrl).host.replace(/[^\w.-]/g, '_')}.json`);

export async function loadOrCreateLocalAgent(
  serverUrl: string,
): Promise<LocalAgent> {
  const path = keyPath(serverUrl);
  let stored: StoredKey | undefined;

  try {
    stored = JSON.parse(await readFile(path, 'utf8')) as StoredKey;
  } catch {
    stored = undefined;
  }

  if (!stored?.privateKey || !stored.publicKey) {
    stored = await Agent.generateKeyPair();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  const agent = new Agent(
    new JSCryptoProvider(stored.privateKey),
    agentSubject(stored.publicKey),
  );

  return { agent, publicKey: stored.publicKey, path };
}
