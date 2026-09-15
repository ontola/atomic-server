# `atomic-server`

_The contents of this readme have been moved to [../README.md](https://github.com/atomicdata-dev/atomic-server)._

## Optional plugin runtime

The `wasm-plugins` Cargo feature is enabled by default. It controls Wasmtime,
the embedded JavaScript/WASM plugin runtime, and the runtime's HTTP endpoints.
To retain the other default features while omitting it:

```sh
cargo build -p atomic-server --no-default-features --features https,telemetry,img
```

For a smaller HTTPS build, use `--no-default-features --features light`.
Browser-side integration-proxy connections do not require this server runtime.
