import 'rust_init_native.dart' if (dart.library.html) 'rust_init_web.dart'
    as impl;

Future<void> initRustBridge() => impl.initRustBridge();
