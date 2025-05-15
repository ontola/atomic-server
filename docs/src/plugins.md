# Atomic Plugins

Atomic Plugins are applications that can run inside of an Atomic Server.
They enhance the functionality of an Atomic Server.
For example, they can:

- Extend existing resources (e.g. automatic translations)
- Provide new endpoints (maybe even ports?) with custom functionality (e.g. full text search for pod data, an e-mail server)
- Periodically execute some code (e.g. fetch new data from a source)
- Add datatypes and validation

## The Plugin Resource

A Plugin itself is a Resource: it is described using Atoms.
The most important Atom for a Plugin, is the `wasm` property: this contains the actual code.
Other properties include:

- `name`
- `description`
- `author`

## Registering a plugin

When a plugin is installed, the Server needs to be aware of when the functionality of the plugin needs to be called:

- Periodically (if so, when?)
- On a certain endpoint (which endpoint? One or multiple?)
- As a middleware when (specific) resources are created / read / updated.

## Hooks

### BeforeCommit

Is run before a Commit is applied.
Useful for performing authorization or data shape checks.

## Wasm class extenders

Atomic Server can load class extenders that are compiled to WASM + WASI Preview 2 (aka wasip2).
Every extender implements the [`class-extender.wit`](../../lib/wit/class-extender.wit) world and exports:

- `class-url` – the Subject URL of the class to extend
- `on-resource-get`
- `before-commit`
- `after-commit`

Handlers receive JSON-AD payloads that describe the Resource or Commit they should work with and can return an updated JSON-AD document. See the WIT file for the exact record layouts.

### Installing a WASM class extender

1. Build a component that targets `wasm32-wasip2`. Use `wit-bindgen` or `cargo component` to satisfy the interface defined in `lib/wit/class-extender.wit`.
2. Copy the resulting `.wasm` file into the `wasm-class-extenders/` directory inside your Atomic data directory (next to the sled store).
3. Restart `atomic-server` (or recreate the `Db`) so it scans the folder and instantiates your component.

All `.wasm` files in that folder are loaded on startup. Errors are logged but do not prevent the server from running, making it safe to iterate on plugins.

### Sample Wasm extender

See `wasm-plugins/examples/random-folder-extender` for a minimal Rust project that implements the `class-extender` WIT interface. It appends a random suffix to the `name` property of every `https://atomicdata.dev/classes/Folder` resource whenever it is fetched. Build it with `cargo component build --release -p random-folder-extender --target wasm32-wasip2` and copy the resulting `.wasm` into your `wasm-class-extenders/` directory to try it out.
