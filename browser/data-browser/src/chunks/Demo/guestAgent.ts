import { Agent, JSCryptoProvider, core, type Store } from '@tomic/react';
import { saveAgentToIDB } from '../../helpers/agentStorage';

/**
 * Anonymous visitors can run the demo without signing up: they get a
 * throwaway DID agent minted right here. It signs the demo drive's
 * genesis commits and announces presence like any agent — but since
 * everything it touches lives in the local-only demo drive, nothing
 * about it ever reaches the server. Persisted to IndexedDB so a reload
 * keeps the guest identity (and with it, the demo drive).
 *
 * Returns `true` when a guest was created, `false` when an agent
 * already existed.
 */
export async function ensureAgentForDemo(store: Store): Promise<boolean> {
  if (store.getAgent()) {
    // A returning demo guest (agent persisted, but no real account) still
    // needs the guest treatment — their profile row is recreated with
    // each fresh demo workspace.
    return isDemoGuest(store);
  }

  const keys = await Agent.generateKeyPair();
  const subject = `did:ad:agent:${keys.publicKey}`;
  const agent = new Agent(new JSCryptoProvider(keys.privateKey), subject);

  store.setAgent(agent);
  // A throwaway guest must not become the identity this device's node signs
  // peer AUTH with — that survives the demo, and the agent doesn't.
  await saveAgentToIDB(Agent.buildSecret(keys.privateKey, subject), {
    adoptOnDevice: false,
  });

  return true;
}

/** Guests are agents without a personal drive: real accounts get one
 *  during onboarding; demo guests never do (until they sign up). */
async function isDemoGuest(store: Store): Promise<boolean> {
  const agent = store.getAgent();

  if (!agent?.subject) return true;

  try {
    const resource = await store.getResource(agent.subject);

    if (resource.error) return true;

    return !resource.get(core.properties.personalDrive);
  } catch {
    return true;
  }
}
