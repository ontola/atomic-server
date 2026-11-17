{{#title Atomic vs Supabase and Firebase}}
# Atomic vs Supabase and Firebase

Supabase and Firebase are good at what they do: a hosted backend you can start using in an afternoon.
Atomic starts from a different place, and I want to be clear about which one, so you can pick the right tool.

With Supabase and Firebase, the source of truth is a database in their cloud (or in yours, for self-hosted Supabase), and the app on the user's device is a client of it.
With Atomic, the data and the app's logic live on the user's device.
A server is one more peer that holds a copy and stays online.
That is what we mean by [local-first](../local-first.md), and it is how we get [out of vendor lock-in](../motivation.md#give-people-more-control-over-their-data): users keep their data, and you are not tied to one company's infrastructure.

This is a different default, not a better one for everything.
Some apps are much better off with a central SQL database, and the [section below](#what-supabase-and-firebase-do-better) says which.

<div class="atomic-diagram">
<svg viewBox="0 0 420 640" width="100%" style="max-width:520px;height:auto;display:block;margin:1.5em auto" font-family="inherit" font-size="14" fill="currentColor" role="img" aria-labelledby="frag-t frag-d">
  <title id="frag-t">Your data today, and with Atomic</title>
  <desc id="frag-d">Today your data is scattered over many separate services. Each one is closed, charges a fee or shares your data. With Atomic your data lives on your own devices, which sync with each other, with an optional encrypted backup on a server.</desc>
  <defs>
    <marker id="farr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker>
  </defs>
  <g text-anchor="middle">
    <text x="210" y="24" font-weight="700" font-size="16">Today: your data lives in their clouds</text>
    <!-- links -->
    <g stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 4" opacity=".45" fill="none">
      <path d="M210 170L110 112"/><path d="M210 170L210 112"/><path d="M210 170L310 112"/>
      <path d="M210 170L115 170"/><path d="M210 170L305 170"/>
      <path d="M210 170L110 228"/><path d="M210 170L210 228"/><path d="M210 170L310 228"/>
    </g>
    <g stroke="none">
      <rect x="15" y="62" width="110" height="50" rx="10" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="155" y="62" width="110" height="50" rx="10" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="295" y="62" width="110" height="50" rx="10" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="5" y="145" width="110" height="50" rx="10" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="305" y="145" width="110" height="50" rx="10" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="15" y="228" width="110" height="50" rx="10" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="155" y="228" width="110" height="50" rx="10" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="295" y="228" width="110" height="50" rx="10" fill="#B3B4E2" fill-opacity=".55"/>
      <circle cx="210" cy="170" r="34" fill="#99C0B7" fill-opacity=".7"/>
    </g>
    <g>
      <text x="70" y="84">Notes app</text><text x="70" y="102" font-size="12" opacity=".8">closed format</text>
      <text x="210" y="84">Documents</text><text x="210" y="102" font-size="12" opacity=".8">paid per seat</text>
      <text x="350" y="84">Chat</text><text x="350" y="102" font-size="12" opacity=".8">owned by them</text>
      <text x="60" y="167">Photos</text><text x="60" y="185" font-size="12" opacity=".8">shares your data</text>
      <text x="360" y="167">Tasks</text><text x="360" y="185" font-size="12" opacity=".8">paid, no export</text>
      <text x="70" y="250">Files</text><text x="70" y="268" font-size="12" opacity=".8">closed, paid</text>
      <text x="210" y="250">Forms</text><text x="210" y="268" font-size="12" opacity=".8">sells your data</text>
      <text x="350" y="250">Backend</text><text x="350" y="268" font-size="12" opacity=".8">locked in</text>
      <text x="210" y="175" font-weight="700">You</text>
    </g>
    <text x="210" y="306" font-size="13" opacity=".85">Many accounts, many silos, no single copy you control.</text>

    <line x1="20" y1="330" x2="400" y2="330" stroke="currentColor" opacity=".25"/>

    <text x="210" y="364" font-weight="700" font-size="16">With Atomic: your data lives on your devices</text>
    <g stroke="none">
      <rect x="10" y="385" width="400" height="125" rx="16" fill="#6B94A6" fill-opacity=".18"/>
      <rect x="25" y="410" width="100" height="70" rx="12" fill="#99C0B7" fill-opacity=".6"/>
      <rect x="160" y="410" width="100" height="70" rx="12" fill="#99C0B7" fill-opacity=".6"/>
      <rect x="295" y="410" width="100" height="70" rx="12" fill="#99C0B7" fill-opacity=".6"/>
      <rect x="130" y="560" width="160" height="56" rx="12" fill="#BD99C0" fill-opacity=".55"/>
    </g>
    <text x="210" y="402" font-size="12" opacity=".85">Your devices: a full copy on each</text>
    <text x="75" y="440">Phone</text><text x="75" y="460" font-size="12" opacity=".8">full copy</text>
    <text x="210" y="440">Laptop</text><text x="210" y="460" font-size="12" opacity=".8">full copy</text>
    <text x="345" y="440">Tablet</text><text x="345" y="460" font-size="12" opacity=".8">full copy</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#farr)" marker-start="url(#farr)">
      <path d="M127 445H158"/><path d="M262 445H293"/>
    </g>
    <text x="210" y="498" font-size="12" opacity=".85">Open formats, signed edits, no one in the middle</text>
    <path d="M210 512V556" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 4" fill="none" marker-end="url(#farr)"/>
    <text x="210" y="583">Optional backup</text>
    <text x="210" y="602" font-size="12" opacity=".8">encrypted, you hold the key</text>
  </g>
</svg>
</div>

## At a glance

| | Atomic | Supabase | Firebase |
| --- | --- | --- | --- |
| **Source of truth** | Every device holds a full copy. A server is one more peer. | A hosted Postgres database. | Hosted Firestore / Realtime Database. |
| **Offline** | The app reads and writes the local store, so it works offline by design. Edits wait in an outbox and sync later. | Needs a connection by default. Offline support is something you build. | Firestore has an offline cache, but the server stays authoritative. |
| **Concurrent edits** | Each Resource is a [Loro](https://loro.dev) CRDT, so edits made apart merge without a coordinator. Business rules are still yours to check. | Postgres transactions and constraints, enforced by one database. | Transactions and last-write-wins on fields, decided by the server. |
| **Identity** | An Ed25519 keypair on the device. No signup, no server involved. See [Agents](../agents.md). | Auth product with users, sessions and providers. | Auth product with users, sessions and providers. |
| **Permissions** | `read` and `write` rights on the [Drive hierarchy](../hierarchy.md), checked by every node that receives data. | Postgres row level security policies. | Security rules. |
| **Queries** | Local queries and [full-text search](../js-lib/store.md#full-text-search) on the client. No SQL. | Full SQL. | Document queries with indexes. |
| **Files** | [File Resources](../files.md) in the same hierarchy, with the same permissions. | Storage buckets. | Cloud Storage. |
| **Realtime** | Built in: every [subscription](../js-lib/store.md) sees local and remote edits alike. | Realtime channels. | Realtime listeners (`onSnapshot`). |
| **Server-side code** | [Plugins](../plugins.md) (WebAssembly or JavaScript) that run inside an AtomicServer. | Edge functions, database functions and triggers. | Cloud functions. |
| **Hosting** | Self-host [AtomicServer](../atomic-server.md), or run no server at all and sync device to device. | Hosted, or self-hosted. | Hosted by Google. |
| **License and lock-in** | MIT licensed. Data and identity are on your devices, and every change is signed, so any node can replace the server. | Open source, built on standard Postgres. | Proprietary service. |

## What Supabase and Firebase do better

Honestly, quite a lot:

- **SQL.** Supabase gives you full SQL: joins, aggregates, views, window functions, reporting. Atomic has no SQL. If your app is mostly queries across large tables, that matters a lot.
- **Transactions and constraints.** Postgres enforces foreign keys, unique constraints and serializable transactions across all data. Atomic has no cross-replica transactions: two offline devices can make edits that are each valid and together are not. Merging does not check your business rules.
- **Extensions.** Postgres has a deep extension ecosystem, such as pgvector for embeddings.
- **Scale and infrastructure.** Both are managed platforms built for large amounts of data and traffic, with global infrastructure operated for you. An AtomicServer is a single-node store aimed at app-sized data, and you run it yourself.
- **Auth.** Both have mature authentication: OAuth providers, magic links, phone login, and the account recovery flows users expect. With Atomic the identity is a key, so backup and recovery of that key is something your app has to design.
- **Functions.** Edge and cloud functions are well established. Atomic plugins exist, but the ecosystem is younger.
- **Ecosystem.** Dashboards, client libraries, tutorials, integrations and a large community. Atomic's is smaller.

If you are weighing a move, read [Migrating from PostgreSQL](../local-first-guide/8-from-postgres.md) and [When (not) to use Atomic Data](../when-to-use.md).
You can also keep Postgres for authoritative transactions and reporting, and use Atomic for the collaborative, offline or user-owned part.

## Which should I pick?

Atomic fits when:

- Users edit the same data together, or on several devices, and the app should keep working offline.
- Users should own their data, or be able to take it elsewhere.
- You want identity without a signup flow, and permissions that every node enforces, not only your backend.
- You want to self-host, or to run without a central server at all.

Supabase or Firebase fit when:

- Your data is central business data with heavy reporting, joins and aggregates.
- You need transactions and constraints across all data.
- You want managed infrastructure and mature auth providers from day one.
- Users do not need to own their data, and always being online is fine.

## Coming from Supabase or Firebase

| Supabase / Firebase | Atomic |
| --- | --- |
| `createClient` / `initializeApp` | [`Store`](../js-lib/store.md) |
| Auth user | [Agent](../agents.md), a keypair |
| Table / collection | Class |
| Row / document | [Resource](../js-lib/resource.md) |
| Realtime channel / `onSnapshot` | `store.subscribe` |
| RLS / security rules | `read` and `write` rights in the [Drive hierarchy](../hierarchy.md) |
| Storage bucket | [Files](../files.md) |
| Project | [Drive](../hierarchy.md) |

## Try it in ten minutes

Install the library with `npm install @tomic/lib`.
This is a condensed version of the [local-first guide](../local-first-guide/1-index.md), which has the full code, persistence and a second device.

```ts
import { Agent, JSCryptoProvider, Store, StoreEvents, core } from '@tomic/lib';

// An identity is a keypair. No request is made.
const keys = await Agent.generateKeyPair();
const subject = `atomic:agent:${keys.publicKey}`;
const agent = new Agent(new JSCryptoProvider(keys.privateKey), subject);

// A Store and a Drive, with no server.
const store = new Store({ agent });
const drive = await store.createDrive('Reading list', { localOnly: true });
store.setDrive(drive.subject);

// Create and save a Resource. It is saved locally at once.
const book = await store.newResource({
  parent: drive.subject,
  propVals: { [core.properties.name]: 'The Dispossessed' },
});
await book.save();

// Point at a server and offer the Drive to it.
store.on(StoreEvents.SyncStatusChanged, status => {
  console.log(status.serverConnected, status.pendingDirtyCount);
});
store.setServerUrl('http://localhost:9883');
await store.promoteLocalDrive(drive.subject);
```

The server here is a local [AtomicServer](../atomic-server.md).
Next steps are in the guide: [persist across reloads](../local-first-guide/4-persist.md), [sync to a server](../local-first-guide/5-sync-server.md) and [the same Drive on a phone](../local-first-guide/6-phone.md).
