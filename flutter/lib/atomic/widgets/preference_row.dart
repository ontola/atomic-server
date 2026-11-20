import 'package:atomic_chat/atomic_chat.dart' show Preference;
import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:flutter/material.dart';

/// One option of a choice setting: the value and what the row calls it.
class PreferenceChoice<T> {
  const PreferenceChoice(this.value, this.label);
  final T value;
  final String label;
}

/// A row for one [Preference]: a switch when it is a boolean, else the
/// current choice, which opens a menu of [choices]. Follows the preference, so
/// a change from the web app or another screen shows here, and a tap goes
/// through [Preference.set] (saved locally, written to the private drive).
class PreferenceRow<T> extends StatefulWidget {
  const PreferenceRow({
    super.key,
    required this.title,
    required this.preference,
    this.subtitle,
    this.icon,
    this.choices,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final Preference<T> preference;

  /// Null: the preference is a boolean, shown as a switch. Other types need
  /// choices.
  final List<PreferenceChoice<T>>? choices;

  @override
  State<PreferenceRow<T>> createState() => _PreferenceRowState<T>();
}

class _PreferenceRowState<T> extends State<PreferenceRow<T>> {
  /// The menu opens from the value on the right, under it, also when the rest
  /// of the row is tapped.
  final _menu = GlobalKey<PopupMenuButtonState<T>>();

  @override
  Widget build(BuildContext context) {
    final w = widget;
    final preference = w.preference;
    return ValueListenableBuilder<T>(
      valueListenable: preference,
      builder: (context, value, _) {
        final options = w.choices;
        if (options == null) {
          final on = value as bool;
          return shared.SyncRow(
            title: w.title,
            subtitle: w.subtitle,
            icon: w.icon,
            onTap: () => preference.set((!on) as T),
            trailing: Switch(
              value: on,
              onChanged: (next) => preference.set(next as T),
            ),
          );
        }
        // A value that is none of the choices (a custom colour set on the
        // web) shows as itself.
        final current = options.firstWhere((o) => o.value == value,
            orElse: () => PreferenceChoice<T>(value, '$value'));
        return shared.SyncRow(
          title: w.title,
          subtitle: w.subtitle,
          icon: w.icon,
          onTap: () => _menu.currentState?.showButtonMenu(),
          trailing: PopupMenuButton<T>(
            key: _menu,
            initialValue: value,
            position: PopupMenuPosition.under,
            onSelected: preference.set,
            itemBuilder: (_) => [
              for (final o in options)
                PopupMenuItem<T>(value: o.value, child: Text(o.label)),
            ],
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Text(current.label),
              const Icon(Icons.arrow_drop_down),
            ]),
          ),
        );
      },
    );
  }
}
