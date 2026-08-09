{{#title Code-first schemas: define your data model in JavaScript}}

# Code-first schemas

Instead of clicking together Classes and Properties in the browser first, you can
declare your data model **in code** and just use it. There is **no build step, no
codegen, and no publish command** — your schema is a value in your repo, and the
Classes and Properties are published automatically the first time you save data
that uses them.

This works because schemas are **content-addressed**: a Class or Property's
identifier is a hash of its definition (see [`did:ad:frozen`](../did.md)). The
identifier is computed locally, in-process, so your code — not a server — is the
source of truth.

> You'll need a running [Atomic Server](../atomic-server.md) and an
> [Agent](../agents.md) (the data-browser creates one for you on first run — copy
> its secret from **User Settings**).

## 1. Define a schema

`defineSchema` takes a small, JSON-Schema-like object that maps onto Atomic
[Classes](classes.md), [Properties](classes.md), and [Datatypes](datatypes.md):

```ts
// schema.ts
import { defineSchema } from '@tomic/lib';

export const todoSchema = defineSchema({
  name: 'TodoApp',
  version: '1.0.0',
  classes: {
    todo: {
      type: 'object',
      description: 'A task in a todo list',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Task title' },
        done: { type: 'boolean', description: 'Whether the task is complete' },
        dueAt: { type: 'string', format: 'date', description: 'Due date' },
      },
    },
  },
});
```

Each `properties` entry becomes a **Property**, each class a **Class**, and the
whole thing an **Ontology**. `type`/`format` map to Atomic datatypes
(`string`→string, `boolean`→boolean, `string`+`format: date`→date,
`integer`→integer, `number`→float, …). Anything not in `required` is *recommended*.

## 2. Use it — no build step

`todoSchema.classes` and `todoSchema.properties` are typed handles to the
content-addressed ids. Use them directly. The first time you `save()` a resource
that references them, the Store publishes the Class and Property definitions to
your server automatically:

```ts
import { Agent, Store } from '@tomic/lib';
import { todoSchema } from './schema';

const agent = await Agent.fromSecret(process.env.AGENT_SECRET);
const store = new Store({ serverUrl: 'http://localhost:9883', agent });
store.setServerConnected(true);

const todo = await store.newResource({
  isA: todoSchema.classes.todo, // typed; autocompletes 'todo'
  propVals: {
    [todoSchema.properties.title]: 'Buy milk',
    [todoSchema.properties.done]: false,
  },
});

await todo.save(); // ← publishes the todo Class + its Properties if the server lacks them
```

That's the whole loop: **define, use, save.** No `ad-generate`, no generated
files to commit, no separate publish step. Publishing is idempotent (hash-keyed),
so an unchanged schema re-saves with no extra work.

The handles give you autocomplete and typo-safety on class and property keys.
(Per-field inference of `resource.props.title` still requires the generated
bindings below; without them, `props` is loosely typed but works at runtime.)

## 3. Updating your schema

Your schema file is the source of truth. To change the model, **just edit the
file.** The next time your app saves a resource using the changed Class or
Property, the new definition publishes itself — there's nothing else to run.

What happens to identity when you change something is the important part, and
it's designed to keep existing data safe:

- **Add a Class or Property** → new resources are created; everything else is
  untouched.
- **Change only a description, label, or translation** → identifiers stay the
  same. Presentation is not part of a Property's identity, so cosmetic edits never
  churn ids or invalidate data.
- **Change a Property's datatype** (or other machine meaning) → this is a
  breaking change, so it produces a **new** Property. The old one stays valid
  forever, so resources created with it keep working. You're never silently
  reinterpreting existing data.

You get this for free, because `defineSchema` already gives you content-addressed
(`did:ad:frozen:`) ids: every identifier is the hash of its machine meaning. The
*same* definition always yields the *same* id (idempotent; identical definitions
across apps even dedupe), and any change yields a new id deterministically. A
frozen definition is immutable and read-only, and shows a **❄ Frozen** badge in
the data-browser.

### Versioning across releases

- Bump `version` in your schema for a new release; old ids remain resolvable, so
  old data is never orphaned.
- To make a release resolvable **offline, with no server**, commit a
  `*.schema.lock.json` and load it with
  [`Store.loadSchemaLock(lock)`](../js-lib/store.md) — the lockfile travels with
  your code.
- For a stable, *editable* "latest" handle that also renders in the GUI, keep a
  normal Ontology pointing at the current frozen ids — `createSchemaPointer`
  builds one, and its commit history is your version log.

## Optional: `@tomic/cli`

You never *need* the CLI, but [`@tomic/cli`](../js-cli.md) is handy for two things:

- **Pre-publish** a schema so it's browsable in the data-browser before any app
  has saved data: `npx ad-generate schema ./schema.ts`.
- **Generate committed `.ts` bindings** (and a `--lock` file) if you prefer those
  over the inline `defineSchema` handles — this is also what enables fully-typed
  `resource.props.title` access.

## What you keep from the GUI

Code-first does **not** replace the [Ontology editor](../atomicserver/gui.md) or
[table view](../atomicserver/gui/tables.md) —
they still create the same Classes and Properties, and a code-first Ontology
remains fully viewable and editable in the browser. Use whichever fits: define in
code for repeatable, reviewable, version-controlled schemas; use the GUI for quick
exploration.

## Cross-language

A schema's frozen identifiers are a pure function of its content (RFC 8785 JCS +
BLAKE3), so they are reproducible in any language. The Rust SDK
(`atomic_lib::frozen::freeze_schema`) produces byte-for-byte identical ids — so a
schema authored in JavaScript and one authored in Rust converge on the same
resources.
