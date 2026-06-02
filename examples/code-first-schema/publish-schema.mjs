// A tiny @tomic/lib "code-first schema" app.
//
//   AGENT_SECRET=<your agent secret> node publish-schema.mjs
//
// Defines a schema in code, publishes it to a running atomic-server, and prints
// the resulting Ontology subject — which you can then open in the data-browser.
import { Agent, Store } from '@tomic/lib';

const SERVER = process.env.SERVER_URL || 'http://localhost:9883';
const SECRET = process.env.AGENT_SECRET;

if (!SECRET) {
  throw new Error('Set AGENT_SECRET (your agent secret from the data-browser).');
}

// Define the data model in code — JSON-Schema-like, mapped to Atomic.
const todoSchema = {
  name: 'TodoApp',
  version: '1.0.0',
  classes: {
    todo: {
      title: 'Todo',
      description: 'A task in a todo list',
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Task title' },
        done: { type: 'boolean', description: 'Whether the task is complete' },
        dueAt: { type: 'string', format: 'date', description: 'Due date' },
      },
    },
  },
};

const agent = await Agent.fromSecret(SECRET);
const store = new Store({ serverUrl: SERVER, agent });
store.setServerConnected(true);

// Publish the schema as Atomic Class & Property resources under an Ontology.
const registered = await store.registerSchema(todoSchema, { save: true });

console.log('Published ontology:');
console.log('  ONTOLOGY ' + registered.ontology.subject);

for (const [key, resource] of Object.entries(registered.classes)) {
  console.log(`  CLASS    ${key}: ${resource.subject}`);
}

for (const [key, resource] of Object.entries(registered.properties)) {
  console.log(`  PROPERTY ${key}: ${resource.subject}`);
}

process.exit(0);
