# Random Folder Class Extender

This crate shows how to build a Wasm-based class extender for Atomic Server.
It appends a random number to the end of the folder name each time it is fetched.
It also prevents commits to the folder if the name contains uppercase letters.

## Building

AtomicServer plugins are compiled to WebAssempbly (Wasm) using the component model.
You should target the `wasm32-wasip2` architecture when building the project.

```bash
# Install the target if you haven't already.
rustup target add wasm32-wasip2

# Build the plugin.
cargo build --release -p random-folder-extender --target wasm32-wasip2
```

In this example the build output location is `target/wasm32-wasip2/release/random-folder-extender.wasm`.

Copy that file into your servers `plugins/class-extenders/` directory and restart AtomicServer.
The plugin should be automatically loaded.
The plugin folder is located in the same directory as your AtomicServer store.
Check the [docs](https://docs.atomicdata.dev/atomicserver/faq.html#where-is-my-data-stored-on-my-machine) to find this directory.
