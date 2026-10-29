import 'package:atomic_chat/atomic_chat.dart' show AppColors;
import 'package:atomic_store_flutter/atomic_store_flutter.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'package:atomic_flutter/atomic_flutter.dart' show AtomicAccountClient;

import 'src/agent_account.dart';
import 'src/repository.dart';
import 'ui/account_link_dialog.dart';
import 'ui/building_chat_page.dart';
import 'ui/homes_page.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Loads the Rust library; on iOS and macOS it uses `nativeLibrary()`, which
  // knows the plugin's framework path, so no extra argument is needed.
  await AtomicFlutter.init();
  final dir = await getApplicationSupportDirectory();
  final node = await AtomicFlutter.open(
    path: '${dir.path}/atomic_buildings',
    agentName: 'Me',
  );
  final account = AgentAccount(() => node.identity.secret);
  runApp(BuildingsApp(
    BuildingRepository(node.store),
    actions: [AtomicAccountButton(node: node)],
    chat: BuildingChat(
      ai: account.hostedAi,
      connect: (context) => AccountLinkDialog.show(context,
          client: AtomicAccountClient(account.portal),
          save: account.sessions.save),
    ),
  ));
}

class BuildingsApp extends StatelessWidget {
  const BuildingsApp(this.repo,
      {super.key, this.actions = const [], required this.chat});
  final BuildingRepository repo;
  final List<Widget> actions;
  final BuildingChat chat;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'AtomicBuildings',
        theme: ThemeData(
          colorSchemeSeed: Colors.teal,
          useMaterial3: true,
          // The chat screens of atomic_chat read their colours from here.
          extensions: const [AppColors.light],
        ),
        home: HomesPage(repo, actions: actions, chat: chat),
      );
}
