import { Agent, SubtleCryptoProvider, JSCryptoProvider } from '@tomic/react';
import { del, get, set } from 'idb-keyval';

const AGENT_IDB_KEY = 'atomic.agent';

interface StoredAgent {
  keyPair: CryptoKeyPair;
  subject: string;
}

export async function getAgentFromIDB(): Promise<Agent | undefined> {
  const storedAgent = (await get(AGENT_IDB_KEY)) as StoredAgent | undefined;

  if (!storedAgent) {
    return undefined;
  }

  try {
    return new Agent(
      new SubtleCryptoProvider(storedAgent.keyPair),
      storedAgent.subject,
    );
  } catch (e) {
    console.error(e);

    return undefined;
  }
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
  let storedAgent: StoredAgent;

  if (keyPairOrSecret === undefined) {
    await del(AGENT_IDB_KEY);

    return;
  }

  if (typeof keyPairOrSecret === 'string') {
    const [keyPair, newSubject] =
      await SubtleCryptoProvider.createKeysFromSecret(keyPairOrSecret);
    storedAgent = {
      keyPair,
      subject: newSubject,
    };
  } else {
    if (!subject) {
      throw new Error('Subject is required');
    }

    storedAgent = {
      keyPair: keyPairOrSecret,
      subject,
    };
  }

  await set(AGENT_IDB_KEY, storedAgent);
}
