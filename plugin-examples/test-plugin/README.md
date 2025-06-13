# Test Plugin

This plugin is used in the end to end tests.

## Building

To build the plugin run:
```bash
cargo build --release -p test-plugin --target wasm32-wasip2
cargo run --bin package -- --wasm ../../target/wasm32-wasip2/release/test_plugin.wasm --out ./dist/test-plugin.zip
```
