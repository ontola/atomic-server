import { Agent, SubtleCryptoProvider, JSCryptoProvider } from '@tomic/react';
import { del, get, set } from 'idb-keyval';

const AGENT_IDB_KEY = 'atomic.agent';

interface StoredAgent {
  keyPair: CryptoKeyPair;
  subject: string;
}

/** Also stored as fallback when SubtleCrypto is unavailable (insecure context) */
interface StoredAgentFallback {
  privateKey: string;
  subject: string;
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
        return new Agent(
          new SubtleCryptoProvider(storedAgent.keyPair),
          storedAgent.subject,
        );
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
      return new Agent(
        new JSCryptoProvider(fallback.privateKey),
        fallback.subject,
      );
    } catch (e) {
      console.error('Failed to load agent from fallback:', e);
    }
  }

  return undefined;
}

export async function saveAgentToIDB(
  keyPair: CryptoKeyPair,
  subject: string,
): Promise<void>;
export async function saveAgentToIDB(secret: string | undefined): Promise<void>;
export async function saveAgentToIDB(
  keyPairOrSecret: CryptoKeyPair | string | undefined,
  subject?: string,
): Promise<void> {
  if (keyPairOrSecret === undefined) {
    await del(AGENT_IDB_KEY);
    await del(AGENT_FALLBACK_KEY);

    return;
  }

  if (typeof keyPairOrSecret === 'string') {
    // Save fallback (plaintext key) always — works in insecure contexts
    const [, newSubject] = JSCryptoProvider.fromSecret(keyPairOrSecret);
    // The secret is a base64-encoded JSON containing { privateKey, subject }.
    // We extract the privateKey for the JS fallback.
    const decoded = JSON.parse(atob(keyPairOrSecret));
    await set(AGENT_FALLBACK_KEY, {
      privateKey: decoded.privateKey,
      subject: newSubject,
    } satisfies StoredAgentFallback);

    // Also save SubtleCrypto version if available
    if (hasSubtleCrypto()) {
      try {
        const [keyPair, resolvedSubject] =
          await SubtleCryptoProvider.createKeysFromSecret(keyPairOrSecret);
        await set(AGENT_IDB_KEY, {
          keyPair,
          subject: resolvedSubject,
        } satisfies StoredAgent);
      } catch {
        // SubtleCrypto not available — fallback is already saved
      }
    }
  } else {
    if (!subject) {
      throw new Error('Subject is required');
    }

    await set(AGENT_IDB_KEY, {
      keyPair: keyPairOrSecret,
      subject,
    } satisfies StoredAgent);
  }
}
