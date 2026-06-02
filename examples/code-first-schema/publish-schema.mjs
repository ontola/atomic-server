// A tiny @tomic/lib "code-first schema" app — no build step, no codegen.
//
//   AGENT_SECRET=<your agent secret> node publish-schema.mjs
//
// Defines a schema in code, creates a resource that uses it, and saves it.
// The Class and Property definitions are content-addressed and publish
// themselves to the server on the first save — nothing else to run.
import { Agent, Store, defineSchema } from '@tomic/lib';

const SERVER = process.env.SERVER_URL || 'http://localhost:9883';
const SECRET = process.env.AGENT_SECRET;

if (!SECRET) {
  throw new Error('Set AGENT_SECRET (your agent secret from the data-browser).');
}

// Define the data model in code — JSON-Schema-like, mapped to Atomic.
// `todoSchema.classes` / `.properties` are content-addressed `did:ad:frozen` ids,
// computed locally (no server needed to have an identity).
const todoSchema = defineSchema({
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
});

console.log('Schema ids (computed locally, no server):');
console.log('  CLASS    todo  ' + todoSchema.classes.todo);
console.log('  PROPERTY title ' + todoSchema.properties.title);
console.log('  PROPERTY done  ' + todoSchema.properties.done);

const agent = await Agent.fromSecret(SECRET);
const store = new Store({ serverUrl: SERVER, agent });
store.setServerConnected(true);

// Create and save a resource that uses the schema. Saving auto-publishes the
// Class + Property definitions to the server (idempotent, hash-keyed).
const todo = await store.newResource({
  isA: todoSchema.classes.todo,
  propVals: {
    [todoSchema.properties.title]: 'Buy milk',
    [todoSchema.properties.done]: false,
  },
});

await todo.save();

console.log('\nSaved a todo — its Class & Properties are now on the server:');
console.log('  TODO ' + todo.subject);
console.log('Open the class id above in the data-browser to see the schema.');

process.exit(0);
