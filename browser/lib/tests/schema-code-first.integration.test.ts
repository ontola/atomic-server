import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';

import { Agent } from '../src/agent.js';
import { Store } from '../src/store.js';
import { SCHEMA_HASH_PROPERTY } from '../src/schema.js';
import { startServer, type ServerHandle } from './server-fixture.js';
import { todoSchema } from './schema-code-first/producer-schema.js';
import { defineProjectSchema } from './schema-code-first/consumer-schema.js';

async function waitForResource(store: Store, subject: string) {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await store.getResource(subject);
    } catch (e) {
      lastError = e;
      await delay(250);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out fetching ${subject}`);
}

describe('code-first schema publish and reuse', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('publishes a JS-defined schema, then another Store fetches and reuses one Property', async () => {
    const agent = await Agent.fromSecret(server.agentSecret);
    const producer = new Store({ serverUrl: server.serverUrl, agent });
    producer.setServerConnected(true);

    const published = await producer.registerSchema(todoSchema, { save: true });

    const consumer = new Store({ serverUrl: server.serverUrl, agent });
    consumer.setServerConnected(true);

    const fetchedOntology = await waitForResource(
      consumer,
      published.ontology.subject,
    );

    expect(fetchedOntology.get(SCHEMA_HASH_PROPERTY)).toBe(
      published.model.ontology.schemaHash,
    );

    const consumerSchema = defineProjectSchema(
      published.ontology.subject,
      published.model.ontology.schemaHash,
    );
    const registeredConsumerSchema =
      await consumer.registerSchema(consumerSchema);

    expect(registeredConsumerSchema.classes.project.props.requires).toEqual([
      published.properties['todo.title'].subject,
    ]);

    const reusedProperty = await consumer.getProperty(
      published.properties['todo.title'].subject,
    );
    expect(reusedProperty.shortname).toBe('title');

    const project = await consumer.newResource({
      isA: registeredConsumerSchema.classes.project.subject,
      propVals: {
        [published.properties['todo.title'].subject]: 'Shared title',
      },
    });

    expect(project.get(published.properties['todo.title'].subject)).toBe(
      'Shared title',
    );

    producer.disconnect();
    consumer.disconnect();
  }, 60_000);
});
