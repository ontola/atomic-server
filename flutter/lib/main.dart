import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'src/rust/frb_generated.dart';
import 'canvas/infinite_canvas.dart';
import 'gallery/canvas_store.dart';
import 'gallery/gallery_screen.dart';
import 'models/canvas_entry.dart';
import 'screens/login_screen.dart';
import 'screens/pair_screen.dart';
import 'theme.dart';
import 'atomic/atomic_client.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RustLib.init();
  final dir = await getApplicationDocumentsDirectory();
  await AtomicClient.openDb(dir.path);
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  runApp(const AtomicCanvasApp());
}

class AtomicCanvasApp extends StatefulWidget {
  const AtomicCanvasApp({super.key});

  @override
  State<AtomicCanvasApp> createState() => _AtomicCanvasAppState();
}

class _AtomicCanvasAppState extends State<AtomicCanvasApp>
    with WidgetsBindingObserver {
  final CanvasStore _store = CanvasStore();
  CanvasEntry? _openCanvas;
  bool _loggedIn = false;
  final _navKey = GlobalKey<NavigatorState>();
  static const _linkChannel = MethodChannel('app.atomicdata.canvas/deeplink');
  Timer? _eventPoller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _handleInitialLink();
    _linkChannel.setMethodCallHandler(_handleLinkCall);
    AtomicClient.getActiveAgent().then((agent) {
      if (agent != null) _onLoggedIn();
    });
  }

  @override
  void dispose() {
    _eventPoller?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _startEventListener() {
    _eventPoller?.cancel();
    // Reactive loop: blocks in Rust until an event arrives
    Future(() async {
      while (mounted) {
        final event = await AtomicClient.waitForSyncEvent();
        if (event == null) continue;

        final nodeId = event['remote_node_id'] as String? ?? '';
        final count = event['resources_imported'] as int? ?? 0;
        final kind = event['kind'] as String? ?? 'sync';

        final peers = await AtomicClient.getKnownPeers();
        final ctx = _navKey.currentContext;
        if (ctx == null || !ctx.mounted) continue;
        final peer = peers.where((p) => p['node_id'] == nodeId).firstOrNull;
        final name = (peer != null && peer['name']!.isNotEmpty)
            ? peer['name']!
            : '${nodeId.substring(0, nodeId.length.clamp(0, 12))}...';

        String message;
        switch (kind) {
          case 'connected':
            message = '$name connected';
          case 'disconnected':
            message = '$name disconnected';
          default:
            message = '$name synced $count resource${count != 1 ? 's' : ''}';
        }

        ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(
          content: Text(message),
          duration: const Duration(seconds: 2),
        ));
      }
    });
  }

  Future<void> _handleInitialLink() async {
    // Check if the app was launched from a did:ad:node: link
    try {
      final link = await _linkChannel.invokeMethod<String>('getInitialLink');
      if (link != null) _handleDeepLink(link);
    } catch (_) {}
  }

  Future<dynamic> _handleLinkCall(MethodCall call) async {
    if (call.method == 'onNewLink') {
      _handleDeepLink(call.arguments as String);
    }
  }

  void _handleDeepLink(String uri) {
    final peer = PairScreen.parsePeerInfo(uri);
    if (peer == null) return;
    final nodeId = peer.nodeId;
    // Show pair dialog once the app is ready
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = _navKey.currentContext;
      if (ctx != null) {
        PairScreen.show(ctx, nodeId: nodeId);
      }
    });
  }

  void _onLoggedIn() {
    _store.isDarkMode =
        View.of(context).platformDispatcher.platformBrightness ==
            Brightness.dark;
    setState(() => _loggedIn = true);
    _store.load().then((_) {
      if (mounted) setState(() {});
    });
    _startEventListener();
  }

  void _openFromGallery(CanvasEntry canvas) async {
    final isDarkMode = View.of(context).platformDispatcher.platformBrightness ==
        Brightness.dark;
    await _store.loadStrokes(canvas, isDarkMode: isDarkMode);
    if (mounted) setState(() => _openCanvas = canvas);
  }

  void _newCanvas({String? folderId}) {
    if (_openCanvas != null && _openCanvas!.strokes.isEmpty) {
      _store.deleteCanvases([_openCanvas!.id]);
    }
    final canvas = _store.createCanvas(folderId: folderId);
    setState(() => _openCanvas = canvas);
  }

  void _closeCanvas() {
    if (_openCanvas != null) {
      final isDarkMode =
          View.of(context).platformDispatcher.platformBrightness ==
              Brightness.dark;
      _store.onCanvasChanged(_openCanvas!, _openCanvas!.strokes,
          isDarkMode: isDarkMode,
          penColor: _openCanvas!.penColor,
          prevColor: _openCanvas!.prevColor);
    }
    if (_openCanvas != null && _openCanvas!.strokes.isEmpty) {
      _store.deleteCanvases([_openCanvas!.id]);
    }
    setState(() => _openCanvas = null);
  }

  @override
  Widget build(BuildContext context) {
    final isDark = View.of(context).platformDispatcher.platformBrightness ==
        Brightness.dark;
    SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
      systemNavigationBarColor: Colors.transparent,
      systemNavigationBarIconBrightness:
          isDark ? Brightness.light : Brightness.dark,
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: isDark ? Brightness.light : Brightness.dark,
    ));
    return MaterialApp(
      navigatorKey: _navKey,
      title: 'Atomic Canvas',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.system,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1976D2),
          brightness: Brightness.light,
        ),
        useMaterial3: true,
        brightness: Brightness.light,
        scaffoldBackgroundColor: AppColors.light.canvasBg,
        extensions: const [AppColors.light],
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1976D2),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        brightness: Brightness.dark,
        scaffoldBackgroundColor: AppColors.dark.canvasBg,
        extensions: const [AppColors.dark],
      ),
      home: !_loggedIn
          ? LoginScreen(onLoggedIn: _onLoggedIn)
          : !_store.isLoaded
              ? Scaffold(
                  backgroundColor:
                      Theme.of(context).extension<AppColors>()?.canvasBg ??
                          AppColors.dark.canvasBg,
                  body: const SafeArea(
                      child: Center(child: CircularProgressIndicator())),
                )
              : _openCanvas != null
                  ? InfiniteCanvas(
                      key: ValueKey(_openCanvas!.id),
                      canvas: _openCanvas!,
                      store: _store,
                      onClose: _closeCanvas,
                      onNewCanvas: _newCanvas,
                    )
                  : GalleryScreen(
                      store: _store,
                      onOpen: _openFromGallery,
                      onNew: ({folderId}) => _newCanvas(folderId: folderId),
                      onSignOut: () {
                        setState(() {
                          _loggedIn = false;
                          _openCanvas = null;
                          _store.canvases.clear();
                        });
                      },
                    ),
    );
  }
}
