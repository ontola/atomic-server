# Random Folder Class Extender

This crate shows how to build a Wasm-based class extender for Atomic Server. It targets the `class-extender` world defined in `lib/wit/class-extender.wit` and appends a random four-digit suffix to every folder name whenever a resource of class [`https://atomicdata.dev/classes/Folder`](https://atomicdata.dev/classes/Folder) is fetched.

## Building

You'll need [`cargo-component`](https://github.com/bytecodealliance/cargo-component) to compile the component:

```bash
cargo component build --release -p random-folder-extender --target wasm32-wasip2
```

The compiled Wasm component will be written to:

```
target/wasm32-wasip2/release/random-folder-extender.wasm
```

Copy that file into your server's `wasm-class-extenders/` directory (sits next to the sled database). Atomic Server will discover it on startup and automatically append random suffixes to folder names.


