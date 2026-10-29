import 'dart:async';

import 'package:atomic_flutter/atomic_flutter.dart' show AppColorsExt;
import 'package:flutter/material.dart';

import 'assistant_api.dart';
import 'follow_controller.dart';
import 'models.dart';
import 'profile_avatar.dart';

/// The agents who have [subject] open right now, one per agent, as the web
/// shows them: any of their sessions on it counts. Picking only an agent's
/// freshest session hid a browser that moved here while the same person's
/// other tablet, idle elsewhere, had announced later.
List<PresenceItem> viewersOf(List<PresenceItem> items, String subject) {
  final here = <String, PresenceItem>{};
  for (final item in items) {
    if (item.resource != subject) continue;
    final seen = here[item.agent];
    if (seen == null || item.updatedAt > seen.updatedAt) {
      here[item.agent] = item;
    }
  }
  return here.values.toList();
}

/// Reads a drive's presence while a page is on screen: when the host says it
/// changed, and every [interval] as a fallback, so a host that cannot tell
/// still shows people coming and going. Also remembers who the agents are.
class PresenceWatch extends ChangeNotifier {
  /// How often presence is read without the host saying it changed.
  static const interval = Duration(seconds: 5);

  final AssistantApi api;
  final String drive;

  PresenceWatch(this.api, this.drive);

  List<PresenceItem> items = const [];
  final _identities = <String, ProfileIdentity?>{};
  final _asked = <String>{};
  Timer? _timer;
  bool _reading = false;
  bool _disposed = false;

  ProfileIdentity? identity(String agent) => _identities[agent];

  void start() {
    if (_timer != null || _disposed) return;
    api.presenceChanges?.addListener(read);
    _timer = Timer.periodic(interval, (_) => read());
    read();
  }

  void stop() {
    if (_timer == null) return;
    _timer!.cancel();
    _timer = null;
    api.presenceChanges?.removeListener(read);
  }

  Future<void> read() async {
    if (_reading || _disposed) return;
    _reading = true;
    try {
      final read = await api.presence(drive);
      if (_disposed) return;
      final now = DateTime.now().millisecondsSinceEpoch;
      for (final item in read) {
        final before = items.where((i) => i.sessionId == item.sessionId);
        if (before.isEmpty || before.first.resource != item.resource) {
          // How long a move took to show here, as the other device's clock
          // counts (its `updatedAt`).
          debugPrint('[presence] ${item.sessionId} on ${item.resource}, '
              '${now - item.updatedAt} ms after it was set');
        }
      }
      items = read;
      notifyListeners();
      for (final item in read) {
        if (_asked.add(item.agent)) unawaited(_load(item.agent));
      }
    } catch (e) {
      // The last answer stays: a failed read is not everyone leaving.
      debugPrint('[presence] not read: $e');
    } finally {
      _reading = false;
    }
  }

  Future<void> _load(String agent) async {
    try {
      final who = await api.identityOf(agent);
      if (_disposed) return;
      _identities[agent] = who;
      notifyListeners();
    } catch (e) {
      debugPrint('[presence] $agent not known: $e');
    }
  }

  @override
  void dispose() {
    _disposed = true;
    stop();
    super.dispose();
  }
}

/// The others who have the page open, as small overlapping avatars (at most
/// three, then "+N"); nothing when alone. The agent being followed has a ring
/// in the main colour. A tap on one asks [onTap] (the avatar sheet).
class PresenceFacepile extends StatelessWidget {
  static const maxShown = 3;
  static const _radius = 12.0;
  static const _ring = 2.0;
  static const _step = 18.0;

  final PresenceWatch watch;
  final FollowController follow;
  final String subject;
  final void Function(PresenceItem who) onTap;

  const PresenceFacepile({
    super.key,
    required this.watch,
    required this.follow,
    required this.subject,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([watch, follow]),
      builder: (context, _) {
        final viewers = viewersOf(watch.items, subject);
        if (viewers.isEmpty) return const SizedBox.shrink();
        final c = context.appColors;
        final shown = viewers.take(maxShown).toList();
        final more = viewers.length - shown.length;
        const size = (_radius + _ring) * 2;
        return Row(
          key: const Key('presence-facepile'),
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: size + _step * (shown.length - 1),
              height: size,
              child: Stack(children: [
                for (final (i, who) in shown.indexed)
                  Positioned(
                    left: i * _step,
                    child: GestureDetector(
                      key: Key('presence-avatar-${who.agent}'),
                      behavior: HitTestBehavior.opaque,
                      onTap: () => onTap(who),
                      child: Container(
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(
                              width: _ring,
                              // The page's colour separates overlapping
                              // avatars; the followed one is ringed instead.
                              color: follow.isFollowing(who.agent)
                                  ? Theme.of(context).colorScheme.primary
                                  : c.bgBody),
                        ),
                        child: ProfileAvatar.of(watch.identity(who.agent),
                            radius: _radius),
                      ),
                    ),
                  ),
              ]),
            ),
            if (more > 0)
              Padding(
                padding: const EdgeInsets.only(left: 4),
                child: Text('+$more',
                    key: const Key('presence-more'),
                    style: TextStyle(color: c.textSecondary, fontSize: 12)),
              ),
          ],
        );
      },
    );
  }
}

/// What the avatar sheet can ask for.
enum PresenceChoice { profile, message, follow, stopFollowing }

/// The sheet an avatar opens: who it is, then Profile, Message and Follow
/// (not when they turned following off; Stop following for the one being
/// followed). Answers the choice; null when dismissed.
Future<PresenceChoice?> showPresenceSheet(
  BuildContext context, {
  required PresenceItem who,
  required ProfileIdentity? identity,
  required bool following,
  bool canMessage = true,
}) {
  return showModalBottomSheet<PresenceChoice>(
    context: context,
    showDragHandle: true,
    builder: (context) {
      final name = identity?.name?.trim() ?? '';
      void pick(PresenceChoice choice) => Navigator.of(context).pop(choice);
      return SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: ProfileAvatar.of(identity),
            title: Text(name.isEmpty ? 'Someone' : name,
                style: const TextStyle(fontWeight: FontWeight.w600)),
          ),
          ListTile(
            leading: const Icon(Icons.person_outline),
            title: const Text('Profile'),
            onTap: () => pick(PresenceChoice.profile),
          ),
          if (canMessage)
            ListTile(
              leading: const Icon(Icons.chat_bubble_outline),
              title: const Text('Message'),
              onTap: () => pick(PresenceChoice.message),
            ),
          if (following)
            ListTile(
              leading: const Icon(Icons.person_off_outlined),
              title: const Text('Stop following'),
              onTap: () => pick(PresenceChoice.stopFollowing),
            )
          else if (who.allowFollow)
            ListTile(
              leading: const Icon(Icons.visibility_outlined),
              title: const Text('Follow'),
              onTap: () => pick(PresenceChoice.follow),
            ),
        ]),
      );
    },
  );
}
