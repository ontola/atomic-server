import 'package:flutter/material.dart';

/// Subscribes to a stream once (created in [stream], so a rebuild does not
/// resubscribe) and builds with its latest value.
class Watch<T> extends StatefulWidget {
  const Watch({super.key, required this.stream, required this.builder});
  final Stream<T> Function() stream;
  final Widget Function(BuildContext context, T data) builder;

  @override
  State<Watch<T>> createState() => _WatchState<T>();
}

class _WatchState<T> extends State<Watch<T>> {
  late final Stream<T> _stream = widget.stream();

  @override
  Widget build(BuildContext context) => StreamBuilder<T>(
        stream: _stream,
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Text('${snap.error}'));
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          return widget.builder(context, snap.data as T);
        },
      );
}

/// Asks for one line of text; null when cancelled or empty.
Future<String?> askText(BuildContext context, String title) async {
  final controller = TextEditingController();
  final text = await showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: TextField(controller: controller, autofocus: true),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel')),
        FilledButton(
          onPressed: () => Navigator.pop(context, controller.text.trim()),
          child: const Text('OK'),
        ),
      ],
    ),
  );
  return text == null || text.isEmpty ? null : text;
}
