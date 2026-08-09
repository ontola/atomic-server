import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';

import { Agent } from '../src/agent.js';
import { Store } from '../src/store.js';
import { Datatype } from '../src/datatypes.js';
import { core } from '../src/ontologies/core.js';
import { startServer, type ServerHandle } from './server-fixture.js';

const todoSchema = {
  name: 'FrozenTodoApp',
  classes: {
    todo: {
      type: 'object' as const,
      required: ['title'],
      properties: {
        title: { type: 'string' as const, description: 'Task title' },
        done: { type: 'boolean' as const },
      },
    },
  },
};

describe('frozen schema: publish + resolve through a real server', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('producer publishes frozen resources; a fresh consumer resolves and uses them', async () => {
    const agent = await Agent.fromSecret(server.agentSecret);
    const producer = new Store({ serverUrl: server.serverUrl, agent });
    producer.setServerConnected(true);

    // Freeze + PUT every frozen body to /frozen on the real server.
    const frozen = await producer.registerFrozenSchema(todoSchema, {
      save: true,
    });
    const titleId = frozen.properties['todo.title'];
    const classId = frozen.classes.todo;

    expect(titleId).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);

    // A brand-new consumer with no shared memory and no agent.
    const consumer = new Store({ serverUrl: server.serverUrl });
    consumer.setServerConnected(true);

    // Give the server a beat to have the bytes durably available.
    await delay(250);

    // Resolves over HTTP: GET /frozen -> re-hash verify -> materialize.
    const prop = await consumer.getProperty(titleId);
    expect(prop.shortname).toBe('title');
    expect(prop.datatype).toBe(Datatype.STRING);

    const todoClass = await consumer.getResource(classId);
    expect(todoClass.get(core.properties.shortname)).toBe('todo');
    expect(todoClass.get(core.properties.requires)).toEqual([titleId]);

    // The consumer can build an instance against the frozen class + property.
    const todo = await consumer.newResource({
      isA: classId,
      propVals: { [titleId]: 'Buy milk' },
    });
    expect(todo.getClasses()).toContain(classId);
    expect(todo.get(titleId)).toBe('Buy milk');

    producer.disconnect();
    consumer.disconnect();
  }, 60_000);
});
