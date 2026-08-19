# atomic-data (Python)

Local-first [Atomic Data](https://atomicdata.dev) SDK for Python.

This is **not** an HTTP-only client. It wraps [`atomic_lib`](../lib) — the same
Rust crate that powers AtomicServer, the browser WASM store, and the Flutter
app — through [PyO3](https://pyo3.rs). Reads and writes go to a local [redb]
database. Edits are signed Loro CRDT commits. A server is optional for local
CRUD and Iroh sync; HTTP is still there for schema fetch, search, and
`save_remote()`.

[redb]: https://github.com/cberner/redb

## Why PyO3

The other language bindings already follow this shape:

| Language | Binding | Store |
| --- | --- | --- |
| TypeScript (browser) | `wasm-bindgen` | redb in OPFS |
| Dart / Flutter | `flutter_rust_bridge` | redb on disk |
| Python | **PyO3 + maturin** | redb on disk |
| Kotlin / JVM | UniFFI (`ffi/`) | redb on disk |

Reimplementing commits, Ed25519, and Loro in Python would drift. UniFFI is a
better fit when one IDL must generate Swift + Kotlin + Python; here the Python
API can be idiomatic on its own, the way the Flutter bridge is.

Reads and writes are local by default. Sync is Iroh: `start_peer()`, hand the
node URI to another device, `sync_with()`. After that, `.save()` pushes live.

HTTP is part of the same store: `get("https://…")` GETs JSON-AD (that is how
unknown Class / Property schema items are loaded). Pass `server=` for
AtomicServer `/search` and `Resource.save_remote()` (POST `/commit`). The
core ontology is bundled, so Folder / PlainText / `name` work offline.

## Install (from this repo)

Needs a Rust toolchain and Python 3.9+. There is no PyPI wheel yet, so
the first install compiles `atomic_lib`.

On **Windows** that compile needs [Visual Studio Build Tools] with the
**Desktop development with C++** workload (`link.exe`). GNU/MinGW is not
a supported target. `uv run pytest` will fail at link time without those
tools — that is the host, not the package.

[Visual Studio Build Tools]: https://visualstudio.microsoft.com/visual-cpp-build-tools/

```bash
cd python
uv sync
uv run pytest -q
```

Or without uv:

```bash
pip install maturin pytest
cd python
maturin develop
pytest
```

Then `import atomic_data`.

## Quick start

```python
from atomic_data import Store, urls

store = Store.open("./my-atomic-data")
setup = store.setup("Ada")          # agent + personal drive

note = store.create(
    urls.PLAIN_TEXT,
    name="Hello",
    description="A locally stored note",
)
note["description"] = "Edited offline"
note.save()

got = store.get(note.subject)
print(got["name"], got["description"])

for child in store.query(parent=setup.drive_subject):
    print(child.subject, child.name)

store.flush()

# P2P: start Iroh, give this URI to another device, then sync.
node = store.start_peer()
print(node)  # did:ad:node:…
# other.sync_with(node)
```

Reopen later with the same path and the agent secret from `setup.agent_secret`:

```python
store = Store.open("./my-atomic-data")
store.load_agent(secret)
page = store.get(subject)
```

`Store.in_memory()` is the same API without a directory — useful in tests.

Talk to a running AtomicServer:

```python
store = Store.open("./my-atomic-data", server="https://atomicdata.dev")
page = store.get("https://atomicdata.dev")          # HTTP GET + cache
hits = store.search("folder", limit=10)             # GET /search
note.save_remote()                                  # POST /commit
```

A `Resource` keeps a handle to the store. Drop every `Store` and `Resource`
before opening the same directory again — redb takes an exclusive file lock.

`save()` and `destroy()` validate schema. `PlainText` requires `description`;
`Folder` does not.

## API

- **Store** — `open(path, server=None)`, `in_memory(server=None)`, `setup(name)`,
  `load_agent(secret)`, `create(class_url, name, ...)`, `get(subject)` (HTTP
  GET for unknown `https://` subjects), `search(query)`, `query(...)`,
  `delete(subject)`, `flush()`, context manager
- **Iroh** — `start_peer()`, `peer_id`, `announce()`, `sync_with(node_id)`,
  `add_peer()`, `peers()`, `live_peers()`, `wait_for(subject)`
- **Resource** — dict-like access, `.save()` (local + live-push if peers are
  up), `.save_remote()` (POST `/commit`), `.destroy()`, `.to_dict()`,
  `.to_json()`
- **atomic_data.urls** — well-known class and property URLs

Property keys accept full URLs or shortnames (`name`, `description`, `parent`,
`isA`, …).

## Develop

```bash
cd python
uv sync
uv run pytest -q
```
