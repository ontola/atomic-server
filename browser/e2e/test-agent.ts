import { test } from '@playwright/test';
import { Agent, Store, core, generateKeyPair, server, urls } from '@tomic/lib';

import { SERVER_URL } from './test-environment';

const serverOrigin = new URL(SERVER_URL).origin;

async function redeem(invite: string): Promise<string> {
  const url = new URL(invite);
  if (url.origin !== serverOrigin)
    throw new Error('Use an invite from the server under test.');

  const keys = await generateKeyPair();
  url.searchParams.set('public-key', keys.publicKey);
  const response = await fetch(url, {
    headers: { Accept: 'application/ad+json' },
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(`Test invite returned HTTP ${response.status}`);
  const subject = (await response.json())[server.properties.redirectAgent];
  if (typeof subject !== 'string' || new URL(subject).origin !== serverOrigin)
    throw new Error('The test invite did not create a local agent.');

  return Agent.buildSecret(keys.privateKey, subject);
}

/** The setup invite belongs to the disposable CI node. Workers sign in as ordinary agents. */
export default async function setupTestAgents(): Promise<void> {
  if (process.env.ATOMIC_E2E_AGENT_INVITE) return;
  const setup = process.env.ATOMIC_E2E_SETUP_INVITE;
  if (!setup)
    throw new Error(
      'Set ATOMIC_E2E_AGENT_INVITE to a reusable invite on your test server, or ATOMIC_E2E_SETUP_INVITE for a fresh disposable node.',
    );
  const issuer = Agent.fromSecret(await redeem(setup), 'js');
  const store = new Store({ serverUrl: serverOrigin, agent: issuer });
  const invite = await store.newResource({
    parent: issuer.subject,
    isA: server.classes.invite,
    propVals: {
      [core.properties.read]: [urls.instances.publicAgent],
      [server.properties.target]: issuer.subject!,
    },
  });
  await invite.save();
  process.env.ATOMIC_E2E_AGENT_INVITE = invite.subject;
}

const agents = new WeakMap<object, Promise<string>>();

/** The same test can open a second signed-in context. Different tests get distinct agents. */
export function testAgentSecret(): Promise<string> {
  const info = test.info();
  let secret = agents.get(info);
  if (!secret) {
    secret = redeem(process.env.ATOMIC_E2E_AGENT_INVITE!).then(async value => {
      const agent = Agent.fromSecret(value, 'js');
      const store = new Store({ serverUrl: serverOrigin, agent });
      const profile = await store.getResource(agent.subject!);
      await profile.set(core.properties.name, 'Test User');
      await profile.save();
      return value;
    });
    agents.set(info, secret);
  }
  return secret;
}
