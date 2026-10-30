import 'dart:async';

import 'package:atomic_flutter/atomic_flutter.dart' show AppColorsExt;
import 'package:flutter/material.dart';

import 'assistant_api.dart';
import 'follow_controller.dart';
import 'meeting_lead.dart';
import 'models.dart';
import 'presence_facepile.dart';

/// A meeting that is happening on a drive: [meeting] is listed on the drive
/// (`currentMeetings`) and [leader]'s presence entry announces it as its
/// `session`.
typedef LiveMeeting = ({String meeting, PresenceItem leader});

/// The most recently announced live meeting among [items], as the web's
/// `MeetingBanner` finds it. [current] is the drive's `currentMeetings`; null
/// when the host cannot tell (the announcement alone then counts).
LiveMeeting? liveMeetingOf(List<PresenceItem> items, Set<String>? current) {
  LiveMeeting? freshest;
  for (final item in items) {
    final meeting = item.session;
    if (meeting == null || (current != null && !current.contains(meeting))) {
      continue;
    }
    if (freshest == null || item.updatedAt > freshest.leader.updatedAt) {
      freshest = (meeting: meeting, leader: item);
    }
  }
  return freshest;
}

/// "Live meeting · Join": a thin strip shown on the home and above resource
/// pages while the drive has a live meeting this device is not leading. Join
/// asks [onJoin], which follows the leader and opens the meeting.
class LiveMeetingBanner extends StatefulWidget {
  /// How long the drive's `currentMeetings` is trusted before it is read again.
  static const recheck = Duration(seconds: 15);

  final AssistantApi api;
  final String drive;

  /// The page's presence watch; the banner reads the drive's presence itself
  /// when there is none (the home).
  final PresenceWatch? watch;
  final MeetingLead? lead;
  final FollowController? follow;
  final void Function(LiveMeeting live) onJoin;

  /// The resource the strip sits above: no strip there once joined (the page
  /// is the meeting).
  final String? hideWhenJoinedOn;

  const LiveMeetingBanner({
    super.key,
    required this.api,
    required this.drive,
    required this.onJoin,
    this.hideWhenJoinedOn,
    this.watch,
    this.lead,
    this.follow,
  });

  @override
  State<LiveMeetingBanner> createState() => _LiveMeetingBannerState();
}

class _LiveMeetingBannerState extends State<LiveMeetingBanner> {
  PresenceWatch? _own;
  late PresenceWatch _watch;
  Set<String>? _current;
  bool _currentKnown = false;
  DateTime _read = DateTime.fromMillisecondsSinceEpoch(0);
  bool _reading = false;

  @override
  void initState() {
    super.initState();
    _attach();
  }

  void _attach() {
    final given = widget.watch;
    if (given == null) {
      _own = PresenceWatch(widget.api, widget.drive)..start();
    }
    _watch = given ?? _own!;
    _watch.addListener(_changed);
    widget.lead?.addListener(_changed);
    widget.follow?.addListener(_changed);
    _changed();
  }

  void _detach() {
    _watch.removeListener(_changed);
    widget.lead?.removeListener(_changed);
    widget.follow?.removeListener(_changed);
    _own?.dispose();
    _own = null;
  }

  @override
  void didUpdateWidget(LiveMeetingBanner old) {
    super.didUpdateWidget(old);
    if (old.watch != widget.watch ||
        old.drive != widget.drive ||
        old.lead != widget.lead ||
        old.follow != widget.follow) {
      // Hand the listeners over; the listed meetings belong to the drive.
      _watch.removeListener(_changed);
      old.lead?.removeListener(_changed);
      old.follow?.removeListener(_changed);
      _own?.dispose();
      _own = null;
      if (old.drive != widget.drive) {
        _current = null;
        _currentKnown = false;
        _read = DateTime.fromMillisecondsSinceEpoch(0);
      }
      _attach();
    }
  }

  @override
  void dispose() {
    _detach();
    super.dispose();
  }

  /// Presence (or the lead, or following) changed: read the drive's listed
  /// meetings when something announces one and they are not fresh.
  void _changed() {
    if (!mounted) return;
    final announced = _watch.items.any((i) => i.session != null);
    if (announced &&
        !_reading &&
        DateTime.now().difference(_read) > LiveMeetingBanner.recheck) {
      unawaited(_readCurrent());
    }
    setState(() {});
  }

  Future<void> _readCurrent() async {
    _reading = true;
    final drive = widget.drive;
    try {
      final read = await widget.api.currentMeetings(drive);
      if (!mounted || drive != widget.drive) return;
      _current = read;
      _currentKnown = true;
      _read = DateTime.now();
      setState(() {});
    } catch (e) {
      debugPrint('[meeting] currentMeetings not read: $e');
      _read = DateTime.now();
    } finally {
      _reading = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.lead?.meetingIn(widget.drive) != null) {
      return const SizedBox.shrink();
    }
    final live = liveMeetingOf(_watch.items, _currentKnown ? _current : null);
    if (live == null) return const SizedBox.shrink();
    final c = context.appColors;
    final primary = Theme.of(context).colorScheme.primary;
    final name = _watch.identity(live.leader.agent)?.name?.trim() ?? '';
    final joined = widget.follow?.isFollowing(live.leader.agent) ?? false;
    if (joined && widget.hideWhenJoinedOn == live.meeting) {
      return const SizedBox.shrink();
    }
    return Material(
      color: c.bgBody,
      child: InkWell(
        key: const Key('live-meeting-banner'),
        onTap: () => widget.onJoin(live),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: c.border)),
            color: primary.withValues(alpha: 0.08),
          ),
          child: Row(children: [
            Icon(Icons.videocam_outlined, size: 20, color: primary),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                name.isEmpty ? 'Live meeting' : 'Live meeting · $name',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    color: c.textPrimary, fontWeight: FontWeight.w600),
              ),
            ),
            const SizedBox(width: 8),
            Container(
              key: const Key('live-meeting-join'),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              decoration: BoxDecoration(
                color: primary,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Text(joined ? 'Open' : 'Join',
                  style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w700,
                      fontSize: 13)),
            ),
          ]),
        ),
      ),
    );
  }
}
