import 'package:atomic_store/atomic_store.dart';
import 'package:flutter/material.dart';

import '../src/repository.dart';
import '../src/terms.g.dart';
import 'common.dart';

class SourcesView extends StatelessWidget {
  const SourcesView(this.repo, this.home, {super.key});
  final BuildingRepository repo;
  final Resource home;

  @override
  Widget build(BuildContext context) => Watch(
        stream: () => repo.watchSources(home),
        builder: (context, sources) => ListView(children: [
          for (final s in sources)
            ListTile(
              leading: const Icon(Icons.attachment),
              title: Text(s.name ?? '(unnamed)'),
              subtitle: Text(
                  '${s.getString(Bldg.mediaKind)} · ${s.getString(Bldg.sourceStatus)}'),
            ),
        ]),
      );
}
