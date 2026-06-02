import { Agent, Store } from '@tomic/lib';
import { atomicConfig } from './config.js';

const DEFAULT_SERVER_URL = 'http://localhost:9883';

const getCommandIndex = (): number | undefined => {
  const agentIndex = process.argv.indexOf('--agent');
  if (agentIndex !== -1) return agentIndex;

  const shortAgentIndex = process.argv.indexOf('-a');
  if (shortAgentIndex !== -1) return shortAgentIndex;

  return undefined;
};

export const getAgent = async (): Promise<Agent | undefined> => {
  let secret;
  const agentCommandIndex = getCommandIndex();

  if (agentCommandIndex) {
    secret = process.argv[agentCommandIndex + 1];
  } else {
    secret = atomicConfig.agentSecret;
  }

  if (!secret) return undefined;

  return Agent.fromSecret(secret, 'js');
};

export const store = new Store({
  serverUrl: atomicConfig.serverUrl ?? DEFAULT_SERVER_URL,
});

getAgent().then(agent => {
  if (agent) {
    store.setAgent(agent);
  }
});

export const createConfiguredStore = async (): Promise<Store> => {
  const configuredStore = new Store({
    serverUrl: atomicConfig.serverUrl ?? DEFAULT_SERVER_URL,
  });
  const agent = await getAgent();

  if (agent) {
    configuredStore.setAgent(agent);
  }

  return configuredStore;
};
