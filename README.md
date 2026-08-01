![AtomicServer](./logo.svg)

[![crates.io](https://img.shields.io/crates/v/atomic-server)](https://crates.io/crates/atomic-server)
[![Discord chat](https://img.shields.io/discord/723588174747533393.svg?logo=discord)](https://discord.gg/a72Rv2P)
[![MIT licensed](https://img.shields.io/github/license/atomicdata-dev/atomic-server.svg?color=blue&logo=github&logoColor=blue)](./LICENSE)
[![github](https://img.shields.io/github/stars/atomicdata-dev/atomic-server?style=social)](https://github.com/atomicdata-dev/atomic-server)

**Create, share, fetch and model [Atomic Data](https://docs.atomicdata.dev)!
AtomicServer is a lightweight, yet powerful CMS / Graph Database.
Demo on [atomicdata.dev](https://atomicdata.dev).
Docs on [docs.atomicdata.dev](https://docs.atomicdata.dev/atomic-data-overview)**

This repo also includes:

- [Atomic Data Browser](/browser/data-browser/README.md), the React front-end for Atomic-Server.
- [`@tomic/lib`](/browser/lib/README.md) JS NPM library.
- [`@tomic/react`](/browser/react/README.md) React NPM library.
- [`@tomic/svelte`](/browser/svelte/README.md) Svelte NPM library.
- [`atomic_lib`](lib/README.md) Rust library.
- [`atomic-cli`](cli/README.md) terminal client.
- [`dart/atomic_flutter`](/dart/atomic_flutter) — reusable Dart / Flutter Atomic SDK (auth, sync, pairing UI, workspaces)
- [`flutter`](/flutter) — AtomicCanvas, a collaborative infinite drawing canvas built on `atomic_flutter`
- [`docs`](docs/README.md) documentation / specification for Atomic Data ([docs.atomicdata.dev](https://docs.atomicdata.dev)).

_Status: alpha. [Breaking changes](CHANGELOG.md) are expected until 1.0._

## AtomicServer

<!-- We re-use this table in various places, such as README.md and in the docs repo. Consider this the source. -->
- 🏠  **Local-first**: create and edit data with no server at all. Resources are addressed by [`did:ad` identifiers](https://docs.atomicdata.dev/did) and resolve peer-to-peer over the Mainline DHT, so an identity is a keypair you hold rather than an account on someone else's machine. Edits are signed CRDT commits that merge when you reconnect.
- 🔒  **Encrypted at rest, per agent**: each agent's in-browser database is encrypted with XChaCha20-Poly1305, under a key wrapped by that agent's own private key. Signing out leaves the cache in place but unreadable to the next session — no wipe required.
- 🔑  **Passkey-backed recovery**: a WebAuthn passkey wraps the backup of your agent secret (Argon2id + AES-GCM), so onboarding hands you nothing to write down, and a lost device doesn't have to mean a lost account.
- 🚀  **Fast** (less than 1ms median response time on my laptop), powered by [actix-web](https://github.com/actix/actix-web) and [redb](https://github.com/cberner/redb)
- 🪶  **One self-contained binary** (~70MB): server, web app, full-text search and database in a single file, with no runtime dependencies and nothing to install alongside it.
- 💻  **Runs everywhere** (linux, windows, mac, arm)
- 🔧  **Custom data models**: create your own classes, properties and schemas using the built-in Ontology Editor. All data is verified and the models are sharable using [Atomic Schema](https://docs.atomicdata.dev/schema/intro.html)
- ⚙️  **Restful API**, with [JSON-AD](https://docs.atomicdata.dev/core/json-ad.html) responses.
- 🔎  **Full-text search** with fuzzy search and various operators, often <3ms responses. Powered by [tantivy](https://github.com/quickwit-inc/tantivy).
- ✨  **AI** with [MCP](https://modelcontextprotocol.io/) support, use any model via OpenRouter or host your own with Ollama.
- 🗄️  **Tables**, with strict schema validation, keyboard support, copy / paste support. Similar to Airtable.
- 📄  **Documents**, collaborative, rich text, similar to Google Docs / Notion.
- 💬  **Group chat**, performant and flexible message channels with attachments, search and replies.
- 📂  **File management**: Upload, download and preview attachments.
- 💾  **Event-sourced versioning** / history powered by [Atomic Commits](https://docs.atomicdata.dev/commits/intro.html)
- 🔄  **Real-time synchronization**: instantly communicates state changes with a client. Build dynamic, collaborative apps using [websockets](https://docs.atomicdata.dev/websockets) (using a [single one-liner in react](https://docs.atomicdata.dev/usecases/react) or [svelte](https://docs.atomicdata.dev/svelte)).
- 🧰  **Many serialization options**: to JSON, [JSON-AD](https://docs.atomicdata.dev/core/json-ad.html), and various Linked Data / RDF formats (RDF/XML, N-Triples / Turtle / JSON-LD).
- 📖  **Pagination, sorting and filtering** queries using [Atomic Collections](https://docs.atomicdata.dev/schema/collections.html).
- 🔐  **Authorization** (read / write permissions) and Hierarchical structures powered by [Atomic Hierarchy](https://docs.atomicdata.dev/hierarchy.html)
- 📲  **Invite and sharing system** with [Atomic Invites](https://docs.atomicdata.dev/invitations.html)
- 🌐  **Embedded server** with support for HTTP / HTTPS / HTTP2.0 (TLS) and Built-in LetsEncrypt handshake.
- 📱  **Runs on mobile**: `atomic_lib` compiles into Flutter apps through [flutter_rust_bridge](https://github.com/fzyzcjy/flutter_rust_bridge), so phones get the same local-first store, signing and peer sync as the browser — not a thin REST wrapper. See [`atomic_flutter`](/dart/atomic_flutter) and the [Canvas app](/flutter).
- 📚  **Libraries**: [Javascript / Typescript](https://www.npmjs.com/package/@tomic/lib), [React](https://www.npmjs.com/package/@tomic/react), [Svelte](https://www.npmjs.com/package/@tomic/svelte), [Rust](https://crates.io/crates/atomic-lib), and [Dart / Flutter (`atomic_flutter`)](/dart/atomic_flutter)

https://user-images.githubusercontent.com/2183313/139728539-d69b899f-6f9b-44cb-a1b7-bbab68beac0c.mp4

## Documentation

Check out the [documentation] for installation instructions, API docs, and more.

## Contribute

Issues and PRs are welcome!
And join our [Discord][discord-url]!
[Read more in the Contributors guide.](CONTRIBUTING.md)

[documentation]:https://docs.atomicdata.dev/atomicserver/installation

[discord-badge]: https://img.shields.io/discord/723588174747533393.svg?logo=discord
[discord-url]: https://discord.gg/a72Rv2P
