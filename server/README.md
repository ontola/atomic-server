# AtomicServer

AtomicServer is the self-hostable server for [atomic.place](https://atomic.place): a local-first workspace for documents, tables, files, chat and apps. It stores your data, syncs it between your devices and collaborators in real time, and serves the web app. It is one binary, with the database, full-text search, web app and automatic HTTPS built in.

- **Local-first sync**: [Loro CRDT](https://loro.dev) documents, signed [Atomic Commits](https://docs.atomicdata.dev/commits/intro.html), real-time collaboration over WebSockets, and peer-to-peer sync between devices.
- **Storage**: an embedded [redb](https://www.redb.org/) database, with files stored on disk.
- **Search**: built-in full-text search (typeahead and fuzzy), with optional [vector search](https://docs.atomicdata.dev/atomicserver/installation#vector-search-embeddings-opt-in).
- **Authorization**: read / write rights, [hierarchies](https://docs.atomicdata.dev/hierarchy.html) and [invite links](https://docs.atomicdata.dev/invitations.html).
- **API**: RESTful, with [JSON-AD](https://docs.atomicdata.dev/core/json-ad.html), plus RDF, Turtle, N-Triples and JSON-LD.
- **Plugins**: Wasm plugins and integrations.
- **Runs everywhere**: linux, windows, mac and arm.

See the [root README](../README.md) for the full feature list.

## Quick start

```sh
docker run -p 80:80 -v atomic-storage:/atomic-storage ghcr.io/ontola/atomic-server
```

Then open `http://localhost/` to create your account. The image is published on the GitHub Container Registry; `joepmeneer/atomic-server` on Docker Hub is a mirror.

Prefer a binary? Download one from the [releases page](https://github.com/ontola/atomic-server/releases), or run `cargo install atomic-server --locked`.

Full instructions, HTTPS, reverse proxies and sharing your server: [installation guide](https://docs.atomicdata.dev/atomicserver/installation).

Source and issues: [github.com/ontola/atomic-server](https://github.com/ontola/atomic-server). Licensed under [MIT](../LICENSE).

## Optional plugin runtime

The `wasm-plugins` Cargo feature is enabled by default. It controls Wasmtime,
the embedded JavaScript/WASM plugin runtime, and the runtime's HTTP endpoints.
To retain the other default features while omitting it:

```sh
cargo build -p atomic-server --no-default-features --features https,telemetry,img
```

For a smaller HTTPS build, use `--no-default-features --features light`.
Browser-side integration-proxy connections do not require this server runtime.
