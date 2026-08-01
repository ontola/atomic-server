/// Atomic Data SDK for Flutter.
///
/// Local-first auth, workspaces, sync, and reusable UI so app builders do not
/// need to run a server or rebuild pairing / drive-switch screens.
library atomic_flutter;

export 'src/atomic.dart';
export 'src/atomic_auth.dart';
export 'src/atomic_client.dart';
export 'src/atomic_store.dart';
export 'src/resource.dart';
export 'src/server_info.dart';
export 'src/server_url.dart';
export 'src/session.dart';
export 'src/ui/agent_settings_dialog.dart';
export 'src/ui/drive_switcher.dart';
export 'src/ui/error_snack.dart';
export 'src/ui/login_screen.dart';
export 'src/ui/pair_screen.dart';
export 'src/ui/server_settings_section.dart';
export 'src/rust/frb_generated.dart' show RustLib;
