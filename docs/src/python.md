{{#title Python SDK for Atomic Data}}

# Python SDK

Local-first [Atomic Data](atomic-data-overview.md) for Python. The package
wraps [`atomic_lib`](rust-lib.md) through
[PyO3](https://pyo3.rs) — the same Rust store the browser (WASM) and Flutter
app use. Reads and writes go to a local [redb](https://github.com/cberner/redb)
file. Edits are signed Loro commits. A server is optional for local CRUD and
Iroh; HTTP GET / search / `save_remote()` are still available.

Source: [`python/`](https://github.com/atomicdata-dev/atomic-server/tree/develop/python).

## Install

From a checkout of this repo (needs a Rust toolchain and Python 3.9+).
There is no PyPI wheel yet, so the first install compiles `atomic_lib`.

On Windows, also install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with the **Desktop development with C++** workload. `uv` / maturin link
with MSVC's `link.exe`; GNU/MinGW is not supported. The `Python SDK`
workflow uploads abi3 wheels for Linux and Windows as CI artifacts.

```bash
cd python
uv sync
uv run pytest -q
```

Or without uv:

```bash
pip install maturin
cd python
maturin develop
```

## Quick start

```python
from atomic_data import Store, urls

store = Store.open("./my-atomic-data")
setup = store.setup("Ada")

note = store.create(
    urls.PLAIN_TEXT,
    name="Hello",
    description="A locally stored note",
)
note["description"] = "Edited offline"
note.save()

got = store.get(note.subject)
print(got["name"], got["description"])

# Collection listing: children of a drive
for child in store.query(parent=setup.drive_subject):
    print(child.subject, child.name)

# Property / value filter (AND with parent / class_url when given)
named = store.query(property="name", value="Hello")
drafts = store.query(
    parent=setup.drive_subject,
    class_url=urls.PLAIN_TEXT,
    property="description",
    value="Edited offline",
)

store.flush()
```

`query()` reads this store's index — it is not the HTTP `/query` endpoint.
After `get()` / `save_remote()`, the cached copies are what `query()` sees.
`search()` is the server full-text path.

`setup.agent_secret` is the only way to sign writes after you reopen the
store. Keep it.

```python
store = Store.open("./my-atomic-data")
store.load_agent(secret)
```

`Store.in_memory()` is the same API without a directory.

## HTTP (schema, search, remote save)

The core ontology (Folder, PlainText, `name`, …) is bundled, so validation
works offline. Unknown Class / Property URLs are loaded the same way
`atomic_lib` always has: `store.get("https://…")` GETs JSON-AD and caches it.

```python
store = Store.open("./my-atomic-data", server="https://atomicdata.dev")
# or later: store.server = "https://atomicdata.dev"

schema = store.get("https://atomicdata.dev/classes/Bookmark")
hits = store.search("notes", limit=10)
note.save_remote()   # POST /commit; did:ad: needs store.server
```

`has(subject)` is local-only (no network). `search()` errors if no server is
set. `save()` stays local; `save_remote()` is the HTTP POST.

## P2P sync (Iroh)

```python
node = store.start_peer()          # did:ad:node:…
store.announce()                   # optional pkarr publish
# On the other device, same agent secret (or a grant), then:
other.sync_with(node)
```

After the first sync, connected peers get live Loro updates on `.save()`.
`store.wait_for(subject)` blocks until a local or peer change lands.

Two Iroh nodes cannot share one Python process — `start_peer` is
process-global, same as Flutter. Use two processes (or two devices).

## What this is not (yet)

WebSocket-to-server `SyncSession` is not wrapped. Blobs and history are not
wrapped. Iroh P2P is.
