import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Agent,
  JSCryptoProvider,
  agentSubject,
  core,
  grantsTo,
  type Store,
} from '@tomic/lib';

/**
 * This machine's own Agent for one server: a keypair made here, kept in the
 * user's config directory, never shown to anyone. The person grants it rights
 * from the app ({@link approvalUrl}), the way an issued app key works, so their
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

/** The page in the app where the person allows this key, with a name for it. */
export function approvalUrl(
  appUrl: string,
  publicKey: string,
  name: string,
): string {
  const url = new URL('/app/connect-agent', appUrl);
  url.searchParams.set('key', publicKey);
  url.searchParams.set('name', name);

  return url.toString();
}

/**
 * What the person let this key reach: every resource whose ACL names it.
 * Empty until they click Allow, and again after they revoke it.
 */
export async function grantedTargets(
  store: Store,
  agentSubjectValue: string,
): Promise<string[]> {
  // `read` is what the person shared; `write` alone is what this key created.
  return (await grantsTo(store, agentSubjectValue))
    .filter(grant => grant.read)
    .map(grant => grant.subject);
}

/**
 * Put a readable name on this key's public Agent resource, so the person sees
 * "Claude Code on MacBook" in their Connected apps rather than a key. Only the
 * key itself may edit that resource, so this is the one place it can happen.
 */
export async function publishName(
  store: Store,
  agentSubjectValue: string,
  name: string,
): Promise<void> {
  const profile = await store.getResource(agentSubjectValue);

  if (profile.get(core.properties.name) === name) {
    return;
  }

  await profile.set(core.properties.name, name, false);
  await profile.save();
}
