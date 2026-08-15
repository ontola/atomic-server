import {
  Agent,
  SubtleCryptoProvider,
  JSCryptoProvider,
  legacySubjectFromSecret,
} from '@tomic/react';
import { del, get, set } from 'idb-keyval';
import { adoptAgentOnDevice } from './adoptAgent';
import { clearSessionDbKeys, ensureDbKeyOnSignIn } from './localDbKey';

const AGENT_IDB_KEY = 'atomic.agent';

interface StoredAgent {
  keyPair: CryptoKeyPair;
  subject: string;
  /**
   * Carried across restarts because they only exist on the secret, and the
   * secret is read exactly once — at sign-in. Without them a restored Agent
   * looks brand-new to the pre-DID migration, which reads both and returns at
   * its first line, so a returning user's drives are never adopted. The
   * migration then appears to do nothing forever, having run only in the
   * session where the secret was pasted.
   */
  legacySubject?: string;
  initialDrive?: string;
  /**
   * The derived personal-drive DID. Stored because it cannot be recomputed
   * from the non-extractable keypair beside it: deriving it means signing, and
   * WebCrypto signatures are not reproducible (see
   * `Agent.personalDriveSubject`). Written at sign-in, while the secret is
   * still readable.
   */
  personalDrive?: string;
}

/**
 * A readable private key. Stored *only* where SubtleCrypto is unavailable
 * (an insecure context), never beside a non-extractable keypair.
 */
interface StoredAgentFallback {
  privateKey: string;
  subject: string;
  /** See {@link StoredAgent}. */
  legacySubject?: string;
  initialDrive?: string;
  /** See {@link StoredAgent}. */
  personalDrive?: string;
}

const AGENT_FALLBACK_KEY = 'atomic.agent.fallback';

function hasSubtleCrypto(): boolean {
  try {
    return (
      typeof globalThis.crypto?.subtle?.importKey === 'function' &&
      typeof globalThis.crypto?.subtle?.sign === 'function'
    );
  } catch {
    return false;
  }
}

export async function getAgentFromIDB(): Promise<Agent | undefined> {
  // Try SubtleCrypto first (secure context)
  if (hasSubtleCrypto()) {
    const storedAgent = (await get(AGENT_IDB_KEY)) as StoredAgent | undefined;

    if (storedAgent) {
      try {
        const provider = new SubtleCryptoProvider(storedAgent.keyPair);
        // Prove the stored keypair can actually sign before dropping any
        // readable copy below — a corrupt keypair must not lock the user out.
        await provider.sign('atomic-key-check');

        const agent = new Agent(
          provider,
          storedAgent.subject,
          storedAgent.initialDrive,
        );
        agent.legacySubject = storedAgent.legacySubject;
        agent.personalDrive = storedAgent.personalDrive;

        // Heal installs written while the readable key was saved
        // unconditionally: a plaintext copy beside a non-extractable key hands
        // back exactly what non-extractability is meant to withhold.
        await del(AGENT_FALLBACK_KEY);

        return agent;
      } catch (e) {
        console.warn(
          'Failed to load agent with SubtleCrypto, trying fallback:',
          e,
        );
      }
    }
  }

  // Fallback: load from plaintext private key (insecure context)
  const fallback = (await get(AGENT_FALLBACK_KEY)) as
    | StoredAgentFallback
    | undefined;

  if (fallback) {
    try {
      const agent = new Agent(
        new JSCryptoProvider(fallback.privateKey),
        fallback.subject,
        fallback.initialDrive,
      );
      agent.legacySubject = fallback.legacySubject;
      agent.personalDrive = fallback.personalDrive;

      return agent;
    } catch (e) {
      console.error('Failed to load agent from fallback:', e);
    }
  }

  return undefined;
}

export interface SaveAgentOptions {
  /**
   * Also make this device's embedded node act as this agent (see
   * `helpers/adoptAgent.ts`). Default true — signing in *is* the moment the
   * device takes on an identity. Pass false for throwaway agents (the demo
   * guest) that must not become the node's identity.
   */
  adoptOnDevice?: boolean;
}

export async function saveAgentToIDB(
  keyPair: CryptoKeyPair,
  subject: string,
): Promise<void>;
export async function saveAgentToIDB(
  secret: string | undefined,
  options?: SaveAgentOptions,
): Promise<void>;
export async function saveAgentToIDB(
  keyPairOrSecret: CryptoKeyPair | string | undefined,
  subjectOrOptions?: string | SaveAgentOptions,
): Promise<void> {
  const subject =
    typeof subjectOrOptions === 'string' ? subjectOrOptions : undefined;
  const options =
    typeof subjectOrOptions === 'object' ? subjectOrOptions : undefined;

  if (keyPairOrSecret === undefined) {
    await del(AGENT_IDB_KEY);
    await del(AGENT_FALLBACK_KEY);
    // Sign-out: drop the session copies of the local-database encryption
    // keys. The wrapped copies survive, so the encrypted OPFS caches become
    // readable again on the owning agent's next sign-in — while this
    // signed-out session can no longer open them.
    await clearSessionDbKeys();

    return;
  }

  if (typeof keyPairOrSecret === 'string') {
    await storeSecret(keyPairOrSecret);

    // The device now holds this agent; its node should sign as this agent too.
    // Best-effort and last, so a node that isn't up yet can't block sign-in.
    if (options?.adoptOnDevice !== false) {
      await adoptAgentOnDevice(keyPairOrSecret);
    }

    return;
  }

  if (!subject) {
    throw new Error('Subject is required');
  }

  // Preserve the secret-only fields: this overload re-stores a keypair and
  // has no secret to re-derive them from, and dropping them would silently
  // disable the migration for a returning user.
  const previous = (await get(AGENT_IDB_KEY)) as StoredAgent | undefined;

  await set(AGENT_IDB_KEY, {
    keyPair: keyPairOrSecret,
    subject,
    legacySubject:
      previous?.subject === subject ? previous.legacySubject : undefined,
    initialDrive:
      previous?.subject === subject ? previous.initialDrive : undefined,
    personalDrive:
      previous?.subject === subject ? previous.personalDrive : undefined,
  } satisfies StoredAgent);
}

/** Persist the agent's key, preferring a non-extractable keypair. */
async function storeSecret(secret: string): Promise<void> {
  // The secret is a base64-encoded JSON containing { privateKey, subject }.
  // The raw private key is needed below for the JS fallback record, and to
  // derive the wrapping key for the local-database encryption key — this is
  // the only moment it passes through JS once the keypair is stored
  // non-extractably.
  const decoded = JSON.parse(atob(secret));
  // Derived here, once, from the raw key — the stored keypair cannot
  // reproduce it. See `StoredAgent.personalDrive`.
  const personalDrive = await Agent.personalDriveSubjectFromSecret(secret);

  {
    // Prefer the non-extractable keypair. Once stored this way the private key
    // cannot be read back out of IndexedDB by anything running on this origin,
    // so no readable copy may be left beside it.
    if (hasSubtleCrypto()) {
      try {
        const [keyPair, resolvedSubject] =
          await SubtleCryptoProvider.createKeysFromSecret(secret);
        await set(AGENT_IDB_KEY, {
          keyPair,
          subject: resolvedSubject,
          legacySubject: legacySubjectFromSecret(secret),
          initialDrive: decoded.initialDrive,
          personalDrive,
        } satisfies StoredAgent);
        await del(AGENT_FALLBACK_KEY);

        await ensureLocalDbKey(resolvedSubject, decoded.privateKey);

        return;
      } catch {
        // SubtleCrypto refused the key — fall through to the readable record.
      }
    }

    // Insecure context (plain-HTTP self-hosted origin): Web Crypto is absent,
    // so a readable key is the only way to sign at all. The secret is no more
    // exposed than the unencrypted connection already carrying it.
    const [, newSubject] = JSCryptoProvider.fromSecret(secret);
    await set(AGENT_FALLBACK_KEY, {
      privateKey: decoded.privateKey,
      subject: newSubject,
      legacySubject: legacySubjectFromSecret(secret),
      initialDrive: decoded.initialDrive,
      personalDrive,
    } satisfies StoredAgentFallback);
    // Drop a keypair from a previous account, so it can't be loaded instead.
    await del(AGENT_IDB_KEY);

    await ensureLocalDbKey(newSubject, decoded.privateKey);
  }
}

/**
 * Set up this agent's local-database encryption key (unwrap the durable copy,
 * or create one). Best-effort: a failure here degrades to a fresh cache key,
 * never blocks sign-in.
 */
async function ensureLocalDbKey(
  subject: string,
  privateKey: string,
): Promise<void> {
  try {
    await ensureDbKeyOnSignIn(subject, privateKey);
  } catch (e) {
    console.warn('Failed to prepare local database key:', e);
  }
}
