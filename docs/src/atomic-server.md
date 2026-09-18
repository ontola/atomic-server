{{#title AtomicServer: the always-on device for your Atomic Data}}
# AtomicServer

[`AtomicServer`](https://github.com/atomicdata-dev/atomic-server) is the _reference implementation_ of the Atomic Data Core + Extended specification: a single binary that is a graph database, a real-time headless CMS and a web app.
It was developed parallel to this specification, and it served as a testing ground for various ideas (some of which didn't work, and some of which ended up in the spec).

## The always-on device

In a [local-first](local-first.md) system every device holds its own copy of the data and does its own signing.
What a phone or a browser tab cannot do is stay reachable.
That is AtomicServer's job: it is the device that never sleeps.

- A **browser tab** cannot accept connections, so it needs a server to reach any other device. AtomicServer is what the web app talks to.
- **Collaborators** fetch a Drive from it while your own devices are off.
- It holds a **backup** that survives a lost phone, without holding your key: every commit it stores is signed by the Agent that made it, so the server can replicate but never author.
- It serves the same data over **HTTP**, for `curl`, static site generators and search engines, next to the sync connection the apps use.

You can run one on a laptop, a Raspberry Pi, a VPS or a home NAS. [Atomic Cloud](https://atomicserver.eu) runs one for you.
The same `atomic_lib` also runs inside the browser and in [Flutter apps](flutter.md), which is why a phone can act as an always-on device for another phone, but a server is the shape most people want for the role.

If you are here to build an app, the [local-first guide](local-first-guide/1-index.md) starts without a server and adds one in step 4; the rest of this chapter is about running and using the server itself.

## Features

It's free, open source (MIT license), and has a ton of features:

<!-- Copied from root README -->
- 🏠  **Local-first**: create and edit data with no server at all. Resources are addressed by [`did:ad` identifiers](https://docs.atomicdata.dev/did) and resolve peer-to-peer over the Mainline DHT, so an identity is a keypair you hold rather than an account on someone else's machine. Edits are signed CRDT commits that merge when you reconnect.
- 🔒  **Encrypted at rest, per agent**: each agent's in-browser database is encrypted with XChaCha20-Poly1305, under a key wrapped by that agent's own private key. Signing out leaves the cache in place but unreadable to the next session — no wipe required.
- 🔑  **Passkey-backed recovery**: a WebAuthn passkey wraps the backup of your agent secret (Argon2id + AES-GCM), so onboarding hands you nothing to write down, and a lost device doesn't have to mean a lost account.
- 🚀  **Fast** (less than 1ms median response time on my laptop), powered by [actix-web](https://github.com/actix/actix-web) and [redb](https://github.com/cberner/redb)
- 🪶  **One self-contained binary** (~70MB): server, web app, full-text search and database in a single file, with no runtime dependencies and nothing to install alongside it.
- 💻  **Runs everywhere** (linux, windows, mac, arm)
- 🔧  **Custom data models**: create your own classes, properties and schemas using the built-in Ontology Editor. All data is verified and the models are sharable using [Atomic Schema](https://docs.atomicdata.dev/schema/intro.html)
- ⚙️  **Restful API**, with [JSON-AD](https://docs.atomicdata.dev/core/json-ad.html) responses.
- 🔎  **Full-text search** with prefix typeahead and 1-edit fuzzy matching, often <3ms responses. Same KV index on the server and in the browser.
- ✨  **AI** with [MCP](https://modelcontextprotocol.io/) support, use any model via OpenRouter or host your own with Ollama.
- 🗄️  **Tables**, with strict schema validation, keyboard support, copy / paste support. Similar to Airtable.
- 📄  **Documents**, collaborative, rich text, similar to Google Docs / Notion.
- 💬  **Group chat**, performant and flexible message channels with attachments, search and replies.
- 📂  **File management**: Upload, download and preview attachments.
- 💾  **Versioning** / history from the Loro oplog, with writes authorized by [Atomic Commits](https://docs.atomicdata.dev/commits/intro.html)
- 🔄  **Real-time synchronization**: instantly communicates state changes with a client. Build dynamic, collaborative apps using [Atomic Sync](https://docs.atomicdata.dev/sync) over WebSocket, Iroh or WebRTC (using a [single one-liner in react](https://docs.atomicdata.dev/usecases/react) or [svelte](https://docs.atomicdata.dev/svelte)).
- 🧰  **Many serialization options**: to JSON, [JSON-AD](https://docs.atomicdata.dev/core/json-ad.html), and various Linked Data / RDF formats (RDF/XML, N-Triples / Turtle / JSON-LD).
- 📖  **Pagination, sorting and filtering** queries using [Atomic Collections](https://docs.atomicdata.dev/schema/collections.html).
- 🔐  **Authorization** (read / write permissions) and Hierarchical structures powered by [Atomic Hierarchy](https://docs.atomicdata.dev/hierarchy.html)
- 📲  **Invite and sharing system** with [Atomic Invites](https://docs.atomicdata.dev/invitations.html)
- 🌐  **Embedded server** with support for HTTP / HTTPS / HTTP2.0 (TLS) and Built-in LetsEncrypt handshake.
- 📱  **Runs on mobile**: `atomic_lib` compiles into Flutter apps through [flutter_rust_bridge](https://github.com/fzyzcjy/flutter_rust_bridge), so phones get the same local-first store, signing and peer sync as the browser — not a thin REST wrapper.
- 📚  **Libraries**: [Javascript / Typescript](https://www.npmjs.com/package/@tomic/lib), [React](https://www.npmjs.com/package/@tomic/react), [Svelte](https://www.npmjs.com/package/@tomic/svelte), [Rust](https://crates.io/crates/atomic-lib), and a Dart / Flutter client

## Document undo and redo

While editing a document, use **Cmd-Z** on macOS or **Ctrl-Z** on Windows/Linux
to undo your local edits. Use **Cmd-Shift-Z** or **Ctrl-Shift-Z** to redo.

Undo and redo history survives switching to Data View and returning to the
document within the same signed-in browser session. It is kept in memory;
reloading the page, signing out, or switching accounts starts a new undo history.
Collaborators' edits are not added to your local undo history.
