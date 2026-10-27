{{#title atomic_lib: local-first data engine}}
# atomic_lib: local-first data engine

`atomic_lib` is the embeddable local-first engine that powers AtomicServer,
Atomic CLI, the browser WASM build, and the [Flutter SDK](flutter.md).

The [crate README](https://github.com/ontola/atomic-server/blob/develop/lib/README.md)
is the source for the application API boundary, internal extensions, storage
backends, Cargo features, and compatibility policy. Rustdoc includes that same
README as the crate overview, alongside the reference for each type and method.

Generate a local reference with the database and native transports enabled:

```sh
cargo doc --locked -p atomic_lib --no-deps --features db,iroh,ws,discovery
```

The [published API reference](https://docs.rs/atomic_lib/latest/atomic_lib/)
describes the released version, which may differ from the current checkout.

[Repository and issue tracker](https://github.com/ontola/atomic-server).
