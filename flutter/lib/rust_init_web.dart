Future<void> initRustBridge() async {
  // FRB WASM requires SharedArrayBuffer (COOP/COEP headers) which Flutter's
  // dev server doesn't support. Web uses a pure Dart HTTP client instead.
}
