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
- [`docs`](docs/README.md) documentation / specification for Atomic Data ([docs.atomicdata.dev](https://docs.atomicdata.dev)).

_Status: alpha. [Breaking changes](CHANGELOG.md) are expected until 1.0._

## AtomicServer

<!-- We re-use this table in various places, such as README.md and in the docs repo. Consider this the source. -->
- 🚀  **Fast** (less than 1ms median response time on my laptop), powered by [actix-web](https://github.com/actix/actix-web) and [sled](https://github.com/spacejam/sled)
- 🪶  **Lightweight** (8MB download, no runtime dependencies)
- 💻  **Runs everywhere** (linux, windows, mac, arm)
- 🔧  **Custom data models**: create your own classes, properties and schemas using the built-in Ontology Editor. All data is verified and the models are sharable using [Atomic Schema](https://docs.atomicdata.dev/schema/intro.html)
- ⚙️  **Restful API**, with [JSON-AD](https://docs.atomicdata.dev/core/json-ad.html) responses.
- 🔎  **Ultra-fast search** with multiple strategies: text search (285ns), fuzzy search (159ns), and semantic search (82µs). 99%+ faster than previous implementation. Powered by SQLite FTS5, FST automata, and optional Terraphim integration.
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
- 📚  **Libraries**: [Javascript / Typescript](https://www.npmjs.com/package/@tomic/lib), [React](https://www.npmjs.com/package/@tomic/react), [Svelte](https://www.npmjs.com/package/@tomic/svelte), [Rust](https://crates.io/crates/atomic-lib)

https://user-images.githubusercontent.com/2183313/139728539-d69b899f-6f9b-44cb-a1b7-bbab68beac0c.mp4

## 🔍 High-Performance Search

AtomicServer provides multiple search strategies optimized for different use cases, delivering exceptional performance:

### Search Performance Benchmarks

| Search Method | Time | Throughput | Best For |
|---------------|------|------------|----------|
| **Text Search** | 285ns | 3.5M queries/sec | Real-time search, autocomplete |
| **Fuzzy Search** | 159ns | 6.3M queries/sec | Typo tolerance, partial matches |
| **Cached Queries** | ~260ns | 3.8M queries/sec | Repeated searches |
| **Terraphim Semantic** | 82µs | 12K queries/sec | Concept discovery, quality |
| **Similarity Search** | 290µs | 3.4K queries/sec | Algorithm comparison |

### Search Strategies

#### 1. **SQLite FTS5 Text Search** ⚡
- **Ultra-fast**: 285ns response time (99.74% faster than original)
- **Full-text indexing** with ranking and relevance scoring
- **Intelligent caching** with LRU cache (500 prefix entries)
- **Query sanitization** for safe FTS5 operations

#### 2. **FST Fuzzy Search** 🎯
- **Lightning speed**: 159ns for typo-tolerant search
- **Finite State Transducers** for optimal fuzzy matching
- **Memory-mapped** FST for zero-copy access (25ns)
- **Configurable** edit distance tolerance

#### 3. **Terraphim Semantic Search** 🧠
```toml
# Enable with feature flag
atomic_lib = { features = ["terraphim-search"] }
```
- **High-quality** semantic matching with Jaro-Winkler algorithm
- **Concept mapping** via thesaurus integration
- **Word-by-word** similarity for intelligent multi-word queries
- **82µs** response time while maintaining superior quality

### Architecture Highlights

- **Multi-layered caching**: Hot cache (1000 entries) + Prefix cache (500 entries)
- **Selective cache invalidation**: Preserves performance on resource updates
- **Memory-mapped FST**: Zero-copy file access for optimal memory usage
- **Thread-safe**: Concurrent access via connection pooling and RwLock
- **Migration benefits**: No file locking issues, embedded-friendly

### Migration from Tantivy

The new search implementation provides significant improvements:
- **99%+ performance improvement** across all search operations
- **No file locking issues** with SQLite-based storage
- **Better memory efficiency** with memory-mapped FST
- **Consistent cache behavior** with selective invalidation
- **Single database file** instead of multiple Tantivy index files

## Documentation

Check out the [documentation] for installation instructions, API docs, and more.

## Contribute

Issues and PRs are welcome!
And join our [Discord][discord-url]!
[Read more in the Contributors guide.](CONTRIBUTING.md)

[documentation]:https://docs.atomicdata.dev/atomicserver/installation

[discord-badge]: https://img.shields.io/discord/723588174747533393.svg?logo=discord
[discord-url]: https://discord.gg/a72Rv2P
