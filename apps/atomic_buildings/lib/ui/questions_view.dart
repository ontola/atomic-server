import 'package:atomic_store/atomic_store.dart';
import 'package:flutter/material.dart';

import '../src/repository.dart';
import '../src/terms.g.dart';
import 'common.dart';

/// The inbox: open questions on top, answered ones collapsed below.
class QuestionsView extends StatelessWidget {
  const QuestionsView(this.repo, this.home, {super.key});
  final BuildingRepository repo;
  final Resource home;

  Future<void> _answer(BuildContext context, Resource q) async {
    final kind = q.getString(Bldg.questionKind);
    final options =
        kind == 'confirm' ? ['Yes', 'No'] : q.getStrings(Bldg.options);
    final answer = options.isEmpty
        ? await askText(context, q.name ?? 'Answer')
        : await showDialog<String>(
            context: context,
            builder: (context) =>
                SimpleDialog(title: Text(q.name ?? ''), children: [
              for (final o in options)
                SimpleDialogOption(
                    onPressed: () => Navigator.pop(context, o), child: Text(o)),
            ]),
          );
    if (answer != null) await repo.answerQuestion(q, answer);
  }

  @override
  Widget build(BuildContext context) => Watch(
        stream: () => repo.watchQuestions(home),
        builder: (context, all) {
          final open = all.where((q) => q.isOpen);
          final answered = all.where((q) => !q.isOpen).toList();
          return ListView(children: [
            for (final q in open)
              ListTile(
                leading: const Icon(Icons.help_outline),
                title: Text(q.name ?? ''),
                subtitle: Text(q.getString(Bldg.why) ?? ''),
                onTap: () => _answer(context, q),
              ),
            if (answered.isNotEmpty)
              ExpansionTile(
                title: Text('Answered (${answered.length})'),
                children: [
                  for (final q in answered)
                    ListTile(
                        title: Text(q.name ?? ''),
                        subtitle: Text(q.getString(Bldg.answer) ?? '')),
                ],
              ),
          ]);
        },
      );
}
