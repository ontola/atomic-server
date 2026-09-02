# Random Folder Class Extender

This crate shows how to build a Wasm-based class extender for Atomic Server.
It appends a random number to the end of the folder name each time it is fetched.
It also prevents commits to the folder if the name contains uppercase letters.

## Project Structure

    - `src`: The source code of the plugin.
    - `src/bin`: Some tooling for packaging, specific to this example because of the monorepo.
    - `assets`: A folder that will be included in the plugins zip file. The plugin will have access to this folder at runtime.
    - `plugin.json`: Contains metadata about the plugin like name, namespace, description, etc.
    - `dist`: The output directory for the packaged plugin.

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

## Packaging the plugin

Run the following command to package the plugin into a zip file.

    ```bash
    cargo run --bin package -- --wasm ../../target/wasm32-wasip2/release/random_folder_extender.wasm
    ```

In your own project you can install `atomic-plugin` and run `cargo atomic-plugin` instead.
