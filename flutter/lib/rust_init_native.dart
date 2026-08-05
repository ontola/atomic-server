import 'src/rust/frb_generated.dart';

/// Load the Rust library — once per process, however often this is called.
///
/// `RustLib.init()` throws on a second call, and a second call is normal: the
/// library belongs to the process, not to the widget tree that asked for it, so
/// anything that boots the app again inside a live process (an integration test
/// relaunching it, a retry after a failed start) initialises an already-loaded
/// library. There is nothing to redo — the dynamic library is still there.
Future<void> initRustBridge() async {
  if (RustLib.instance.initialized) return;
  await RustLib.init();
}
