import 'package:flutter/material.dart';

import '../src/repository.dart';
import 'common.dart';
import 'building_chat_page.dart';
import 'home_page.dart';

class HomesPage extends StatelessWidget {
  const HomesPage(this.repo,
      {super.key, this.actions = const [], required this.chat});
  final BuildingRepository repo;
  final List<Widget> actions;

  /// The chat of each Home.
  final BuildingChat chat;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Homes'), actions: actions),
        floatingActionButton: FloatingActionButton(
          tooltip: 'New home',
          onPressed: () async {
            final name = await askText(context, 'Name of the home');
            if (name != null) await repo.createHome(name);
          },
          child: const Icon(Icons.add_home),
        ),
        body: Watch(
          stream: repo.watchHomes,
          builder: (context, homes) => ListView(children: [
            for (final home in homes)
              ListTile(
                leading: const Icon(Icons.home),
                title: Text(home.name ?? '(unnamed)'),
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                      builder: (_) =>
                          HomePage(repo, home, chat: chat, actions: actions)),
                ),
              ),
          ]),
        ),
      );
}
