/**
 * End-to-end DID open / resolve helpers.
 *
 * Share links may carry routing hints (`?agent=` / `?node=` on the subject DID,
 * or on `atomic://open`). When those are absent, we fall back to known peers
 * ("contacts" in the Sync sense — paired devices) and ask the user / auto-try
 * them. See planning/zones.md discovery section.
 */

import { Client } from '@tomic/react';
import { getLocalServerOrigin } from './tauri';
import { pairAndSync } from './pairing';
import { readKnownPeers, type KnownPeer } from './knownPeers';

const NODE_DID_PREFIX = 'did:ad:node:';
const AGENT_DID_PREFIX = 'did:ad:agent:';
const OPEN_LINK_PREFIX = 'atomic://open';

export type DidOpenTarget = {
  /** Resource / zone / agent DID to open (pure subject, may still carry ?drive=). */
  subject: string;
  /** Optional agent DID for pkarr → NodeID resolution. */
  agent?: string;
  /** Optional node DID for direct dial. */
  node?: string;
};

export type ResolveDidResult =
  | { ok: true; subject: string; via: 'local' | 'node' | 'agent' | 'peers' }
  | {
      ok: false;
      subject: string;
      message: string;
      /** Known peers available to try when the caller wants an explicit confirm. */
      peers: KnownPeer[];
    };

/** True when `value` looks like an Atomic subject the app can navigate to. */
export function looksLikeOpenableSubject(value: string): boolean {
  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  return Client.isValidSubject(stripOpenWrappers(trimmed));
}

/**
 * Pull subject/agent/node out of a pasted DID, `atomic://open` link, or raw URL
 * with `?subject=`.
 */
export function parseDidOpenInput(raw: string): DidOpenTarget | null {
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith(OPEN_LINK_PREFIX)) {
    try {
      const url = new URL(trimmed);
      const subject = url.searchParams.get('subject');

      if (!subject || !Client.isValidSubject(subject)) {
        return null;
      }

      return {
        subject: canonicalizeOpenSubject(subject),
        agent: readOptionalAgent(url.searchParams.get('agent')),
        node: readOptionalNode(url.searchParams.get('node')),
      };
    } catch {
      return null;
    }
  }

  // App show URL: /app/show?subject=did:ad:…
  try {
    if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('/')
    ) {
      const url = new URL(trimmed, 'http://local.invalid');
      const subject = url.searchParams.get('subject');

      if (subject && Client.isValidSubject(subject)) {
        return {
          subject: canonicalizeOpenSubject(subject),
          agent: readOptionalAgent(url.searchParams.get('agent')),
          node: readOptionalNode(url.searchParams.get('node')),
        };
      }
    }
  } catch {
    // fall through
  }

  // Bare DID (resource / agent / commit / blob) — may include ?agent=&node=&drive=
  if (trimmed.startsWith('did:ad:')) {
    // Node DIDs are pairing codes, not openable resources.
    if (trimmed.startsWith(NODE_DID_PREFIX) && !trimmed.includes('?')) {
      return null;
    }

    if (!Client.isValidSubject(trimmed.split('?')[0] ?? trimmed)) {
      return null;
    }

    try {
      const url = new URL(trimmed.includes('?') ? trimmed : `${trimmed}?`);
      const agent = readOptionalAgent(url.searchParams.get('agent'));
      const node = readOptionalNode(url.searchParams.get('node'));

      return {
        subject: canonicalizeOpenSubject(trimmed),
        agent,
        node,
      };
    } catch {
      if (Client.isValidSubject(trimmed)) {
        return { subject: canonicalizeOpenSubject(trimmed) };
      }

      return null;
    }
  }

  if (Client.isValidSubject(trimmed)) {
    return { subject: canonicalizeOpenSubject(trimmed) };
  }

  return null;
}

/**
 * Keep identity + `drive` routing hint; strip `agent` / `node` (discovery only).
 */
export function canonicalizeOpenSubject(subject: string): string {
  if (!subject.startsWith('did:ad:') || !subject.includes('?')) {
    return subject;
  }

  try {
    const url = new URL(subject);
    const drive = url.searchParams.get('drive');
    const bare = `${url.protocol}${url.pathname}`; // did:ad:xxx

    if (drive) {
      return `${bare}?drive=${drive}`;
    }

    return bare;
  } catch {
    return subject.split('?')[0] ?? subject;
  }
}

/**
 * Try to materialize `subject` locally. If missing, dial an explicit node,
 * resolve an agent via pkarr, then walk known peers (Sync "contacts").
 *
 * `drive` is the sync scope passed to `/iroh-sync` — prefer the subject's
 * `?drive=` hint, else the caller's current drive, else the subject itself
 * (zone/drive roots).
 */
export async function resolveDidForOpen(
  subject: string,
  options: {
    drive?: string;
    agent?: string;
    node?: string;
    /** When false, do not auto-walk known peers — return them for the UI. */
    tryPeers?: boolean;
    /** Probe whether the subject is already fetchable. */
    isAvailable: (subject: string) => Promise<boolean>;
  },
): Promise<ResolveDidResult> {
  const {
    drive: driveOpt,
    agent,
    node,
    tryPeers = true,
    isAvailable,
  } = options;
  const drive = driveForSync(subject, driveOpt);
  const peers = readKnownPeers();

  if (await isAvailable(subject)) {
    return { ok: true, subject, via: 'local' };
  }

  if (node) {
    try {
      await pairAndSync(node, drive);

      if (await isAvailable(subject)) {
        return { ok: true, subject, via: 'node' };
      }
    } catch (e) {
      console.warn('[didResolve] node dial failed:', e);
    }
  }

  if (agent) {
    const nodes = await resolveAgentNodeIds(agent);

    for (const nodeDid of nodes) {
      try {
        await pairAndSync(nodeDid, drive);

        if (await isAvailable(subject)) {
          return { ok: true, subject, via: 'agent' };
        }
      } catch (e) {
        console.warn('[didResolve] agent peer dial failed:', e);
      }
    }
  }

  if (!tryPeers) {
    return {
      ok: false,
      subject,
      message:
        peers.length === 0
          ? 'Resource not found locally, and you have no known devices to try.'
          : 'Resource not found locally. Try fetching from your known devices?',
      peers,
    };
  }

  for (const peer of peers) {
    // Skip a node we already tried via an explicit hint.
    if (node && peer.nodeId.toLowerCase() === node.toLowerCase()) {
      continue;
    }

    try {
      await pairAndSync(peer.nodeId, drive);

      if (await isAvailable(subject)) {
        return { ok: true, subject, via: 'peers' };
      }
    } catch (e) {
      console.warn('[didResolve] known peer dial failed:', peer.nodeId, e);
    }
  }

  return {
    ok: false,
    subject,
    message:
      peers.length === 0
        ? 'Could not resolve this DID. Pair a device on the Sync page, or add an agent/node hint to the link.'
        : 'Could not resolve this DID from local data or known devices.',
    peers,
  };
}

/** Resolve agent DID → NodeID list via the local server's pkarr client. */
export async function resolveAgentNodeIds(agentDid: string): Promise<string[]> {
  try {
    const response = await fetch(
      `${getLocalServerOrigin()}/resolve-agent?agent=${encodeURIComponent(agentDid)}`,
    );
    const data = (await response.json()) as {
      nodeIds?: string[];
      error?: string;
    };

    if (!response.ok || data.error) {
      console.warn('[didResolve] resolve-agent failed:', data.error);

      return [];
    }

    return (data.nodeIds ?? [])
      .map(id => (id.startsWith(NODE_DID_PREFIX) ? id : `${NODE_DID_PREFIX}${id}`))
      .filter(id => /^did:ad:node:[0-9a-f]{64}$/i.test(id));
  } catch (e) {
    console.warn('[didResolve] resolve-agent request failed:', e);

    return [];
  }
}

function driveForSync(subject: string, driveOpt?: string): string | undefined {
  if (driveOpt) {
    return driveOpt;
  }

  try {
    const url = new URL(
      subject.includes('?') ? subject : `${subject}?`,
      'http://local.invalid',
    );
    const hint = url.searchParams.get('drive');

    if (hint) {
      return hint;
    }
  } catch {
    // ignore
  }

  // Bare resource DID with no drive — sync the subject itself (zone/drive root).
  const bare = subject.split('?')[0] ?? subject;

  if (bare.startsWith('did:ad:') && !bare.startsWith(AGENT_DID_PREFIX)) {
    return bare;
  }

  return undefined;
}

function stripOpenWrappers(value: string): string {
  if (value.startsWith(OPEN_LINK_PREFIX)) {
    try {
      return new URL(value).searchParams.get('subject') ?? value;
    } catch {
      return value;
    }
  }

  return value;
}

function readOptionalAgent(value: string | null): string | undefined {
  if (!value?.startsWith(AGENT_DID_PREFIX)) {
    return undefined;
  }

  return value;
}

function readOptionalNode(value: string | null): string | undefined {
  if (!value?.startsWith(NODE_DID_PREFIX)) {
    return undefined;
  }

  const hex = value.slice(NODE_DID_PREFIX.length).split(':')[0] ?? '';

  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return undefined;
  }

  return `${NODE_DID_PREFIX}${hex}`;
}
