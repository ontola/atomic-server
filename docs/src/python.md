{{#title Python SDK for Atomic Data}}

# Python SDK

Local-first [Atomic Data](atomic-data-overview.md) for Python. The package
wraps [`atomic_lib`](rust-lib.md) through
[PyO3](https://pyo3.rs) — the same Rust store the browser (WASM) and Flutter
app use. Reads and writes go to a local [redb](https://github.com/cberner/redb)
file. Edits are signed Loro commits. A server is optional.

Source: [`python/`](https://github.com/atomicdata-dev/atomic-server/tree/develop/python).

## Install

From a checkout of this repo (needs a Rust toolchain and Python 3.9+):

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

for child in store.query(parent=setup.drive_subject):
    print(child.subject, child.name)

store.flush()
```

`setup.agent_secret` is the only way to sign writes after you reopen the
store. Keep it.

```python
store = Store.open("./my-atomic-data")
store.load_agent(secret)
```

`Store.in_memory()` is the same API without a directory.

## What this is not (yet)

v1 is local read, write, query, and persist. It does not open a WebSocket or
an Iroh session. Those can use the same store later, as they already do in
Flutter.
