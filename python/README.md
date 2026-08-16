# atomic-data (Python)

Local-first [Atomic Data](https://atomicdata.dev) SDK for Python.

This is **not** a thin HTTP client. It wraps [`atomic_lib`](../lib) — the same
Rust crate that powers AtomicServer, the browser WASM store, and the Flutter
app — through [PyO3](https://pyo3.rs). Reads and writes go to a local [redb]
database. Edits are signed Loro CRDT commits. A server is optional.

[redb]: https://github.com/cberner/redb

## Why PyO3

The other language bindings already follow this shape:

| Language | Binding | Store |
| --- | --- | --- |
| TypeScript (browser) | `wasm-bindgen` | redb in OPFS |
| Dart / Flutter | `flutter_rust_bridge` | redb on disk |
| Python | **PyO3 + maturin** | redb on disk |

Reimplementing commits, Ed25519, and Loro in Python would drift. UniFFI is a
better fit when one IDL must generate Swift + Kotlin + Python; here the Python
API can be idiomatic on its own, the way the Flutter bridge is.

v1 is local read / write / query / persist. WebSocket and Iroh sync can sit on
the same store later, as they already do in Flutter.

## Install (from this repo)

Needs a Rust toolchain and Python 3.9+.

```bash
pip install maturin
cd python
maturin develop
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
```

Reopen later with the same path and the agent secret from `setup.agent_secret`:

```python
store = Store.open("./my-atomic-data")
store.load_agent(secret)
page = store.get(subject)
```

`Store.in_memory()` is the same API without a directory — useful in tests.

## API

- **Store** — `open(path)`, `in_memory()`, `setup(name)`, `load_agent(secret)`,
  `create(class_url, name, ...)`, `get(subject)`, `query(...)`, `delete(subject)`,
  `flush()`, context manager
- **Resource** — dict-like access, `.save()`, `.destroy()`, `.to_dict()`, `.to_json()`
- **atomic_data.urls** — well-known class and property URLs

Property keys accept full URLs or shortnames (`name`, `description`, `parent`,
`isA`, …).

## Develop

```bash
cd python
maturin develop
pip install pytest
pytest
```
