import 'resource.dart';
import 'store.dart';
import 'urls.dart';
import 'value.dart';

/// The `notifications` ontology (`lib/defaults/notifications.json`): the
/// Inbox in the private drive, what its owner follows, how they want to be
/// reached, and announcements. The server notifier (`lib/src/notify.rs`)
/// reads these and writes Notifications into the Inbox.
abstract final class NotifyNs {
  static const _c = 'https://atomicdata.dev/classes/';
  static const _p = 'https://atomicdata.dev/properties/';

  static const inboxClass = '${_c}Inbox';
  static const notification = '${_c}Notification';
  static const follow = '${_c}Follow';
  static const pushRegistration = '${_c}PushRegistration';
  static const announcement = '${_c}Announcement';

  /// On the private drive: its Inbox.
  static const inbox = '${_p}inbox';
  static const about = '${_p}about';
  static const followLevel = '${_p}followLevel';
  static const followClasses = '${_p}followClasses';
  static const followProperties = '${_p}followProperties';
  static const recipients = '${_p}recipients';
  static const actionRequired = '${_p}actionRequired';
  static const notificationKind = '${_p}notificationKind';
  static const notificationSource = '${_p}notificationSource';
  static const notificationCount = '${_p}notificationCount';
  static const changedProperties = '${_p}changedProperties';
  static const actor = '${_p}actor';
  static const occurredAt = '${_p}occurredAt';
  static const readAt = '${_p}readAt';
  static const notifyEmail = '${_p}notifyEmail';
  static const emailFrequency = '${_p}emailFrequency';
  static const mutedKinds = '${_p}mutedNotificationKinds';
  static const notifyLanguage = '${_p}notifyLanguage';
  static const pushEndpoint = '${_p}pushEndpoint';
}

/// How much a [Follow] tells: new items and changes, only new items, or
/// nothing (also silencing a follow higher up).
enum FollowLevel {
  everything('everything'),
  newItems('newItems'),
  muted('muted');

  const FollowLevel(this.value);
  final String value;

  static FollowLevel parse(String? s) => switch (s) {
        'newItems' => FollowLevel.newItems,
        'muted' => FollowLevel.muted,
        _ => FollowLevel.everything,
      };
}

/// When mail goes out: one per notification, a daily summary of what is
/// still unread, or none.
enum EmailFrequency {
  instant('instant'),
  daily('daily'),
  off('off');

  const EmailFrequency(this.value);
  final String value;

  static EmailFrequency parse(String? s) => switch (s) {
        'daily' => EmailFrequency.daily,
        'off' => EmailFrequency.off,
        _ => EmailFrequency.instant,
      };
}

/// One thing followed.
class Follow {
  Follow(this.resource);
  final Resource resource;
  String get subject => resource.subject;
  String? get about => resource.getLink(NotifyNs.about);
  FollowLevel get level =>
      FollowLevel.parse(resource.getString(NotifyNs.followLevel));
  List<String> get classes => resource.getLinks(NotifyNs.followClasses);
  List<String> get properties => resource.getLinks(NotifyNs.followProperties);
}

/// One Notification in the Inbox.
class InboxItem {
  InboxItem(this.resource);
  final Resource resource;
  String get subject => resource.subject;
  String get title => resource.name ?? '';
  String get body => resource.getString(Props.description) ?? '';
  String? get about => resource.getLink(NotifyNs.about);
  String get kind => resource.getString(NotifyNs.notificationKind) ?? '';
  String? get actor => resource.getLink(NotifyNs.actor);
  bool get actionRequired => switch (resource.get(NotifyNs.actionRequired)) {
        BooleanValue(:final value) => value,
        _ => false,
      };
  int get count => switch (resource.get(NotifyNs.notificationCount)) {
        IntegerValue(:final value) => value,
        _ => 1,
      };
  List<String> get changedProperties =>
      resource.getLinks(NotifyNs.changedProperties);
  DateTime get at => _time(resource.get(NotifyNs.occurredAt)) ?? DateTime(0);
  bool get read => resource.get(NotifyNs.readAt) != null;
}

DateTime? _time(Value? v) => switch (v) {
      TimestampValue(:final dateTime) => dateTime,
      IntegerValue(:final value) => DateTime.fromMillisecondsSinceEpoch(value),
      _ => null,
    };

/// The Inbox of one private drive: notifications in, settings and follows
/// out. The server notifier only delivers into an Inbox in a drive that
/// nobody but its owner reads or writes, which a private drive is.
///
/// ```dart
/// final inbox = await Inbox.open(store, privateDrive);
/// await inbox.follow(councilDrive, FollowLevel.newItems, classes: [meeting]);
/// await inbox.setEmail('me@example.org', EmailFrequency.daily);
/// ```
class Inbox {
  Inbox._(this.store, this.resource);

  final Store store;
  final Resource resource;
  String get subject => resource.subject;

  /// The Inbox of [privateDrive], made (and linked from the drive) when it
  /// has none yet, as the web app does on first use.
  static Future<Inbox> open(Store store, String privateDrive) async {
    final drive = await store.getResource(privateDrive);
    final existing = drive.getLink(NotifyNs.inbox);
    if (existing != null) {
      final r = await store.getResourceOrNull(existing);
      if (r != null) return Inbox._(store, r);
    }
    final r = store.newResource(
        parent: privateDrive,
        isA: [NotifyNs.inboxClass],
        props: {Props.name: 'Inbox'});
    await r.save();
    drive.set(NotifyNs.inbox, LinkValue(r.subject));
    await drive.save();
    return Inbox._(store, r);
  }

  Future<List<Resource>> _children(String cls) async => [
        for (final c in await resource.children())
          if (c.isA(cls)) c,
      ];

  /// The notifications, newest first.
  Future<List<InboxItem>> items() async {
    final list = [
      for (final r in await _children(NotifyNs.notification)) InboxItem(r)
    ];
    list.sort((a, b) => b.at.compareTo(a.at));
    return list;
  }

  Future<void> markRead(String notification) async {
    final r = await store.getResource(notification);
    if (r.get(NotifyNs.readAt) != null) return;
    r.set(
        NotifyNs.readAt, TimestampValue(DateTime.now().millisecondsSinceEpoch));
    await r.save();
  }

  // Settings, on the Inbox itself, so every device has them.

  String? get email => resource.getString(NotifyNs.notifyEmail);
  EmailFrequency get emailFrequency =>
      EmailFrequency.parse(resource.getString(NotifyNs.emailFrequency));
  List<String> get mutedKinds => resource.getStrings(NotifyNs.mutedKinds);
  String? get language => resource.getString(NotifyNs.notifyLanguage);

  /// Where and how often to mail. [email] null or empty: the server's own
  /// knowledge of the address (an account) is used, if any.
  Future<void> setEmail(String? email, EmailFrequency frequency) async {
    if (email == null || email.trim().isEmpty) {
      resource.remove(NotifyNs.notifyEmail);
    } else {
      resource.set(NotifyNs.notifyEmail, StringValue(email.trim()));
    }
    resource.set(NotifyNs.emailFrequency, StringValue(frequency.value));
    await resource.save();
  }

  Future<void> setMutedKinds(Iterable<String> kinds) async {
    resource.setStrings(NotifyNs.mutedKinds, kinds.toSet());
    await resource.save();
  }

  Future<void> setLanguage(String language) async {
    if (language == this.language) return;
    resource.set(NotifyNs.notifyLanguage, StringValue(language));
    await resource.save();
  }

  // Follows.

  Future<List<Follow>> follows() async =>
      [for (final r in await _children(NotifyNs.follow)) Follow(r)];

  /// The follow on [about] itself, if any (not one above it).
  Future<Follow?> followOf(String about) async {
    for (final f in await follows()) {
      if (f.about == about) return f;
    }
    return null;
  }

  /// Follow [about] at [level], replacing an earlier follow of it.
  /// [classes] and [properties] narrow it (empty: anything).
  Future<Follow> follow(String about, FollowLevel level,
      {List<String> classes = const [],
      List<String> properties = const []}) async {
    final existing = await followOf(about);
    final r = existing?.resource ??
        store.newResource(
            parent: subject,
            isA: [NotifyNs.follow],
            props: {Props.name: 'Follow', NotifyNs.about: LinkValue(about)});
    r.set(NotifyNs.followLevel, StringValue(level.value));
    if (classes.isEmpty) {
      if (!r.isNew) r.remove(NotifyNs.followClasses);
    } else {
      r.set(NotifyNs.followClasses,
          ArrayValue([for (final c in classes) LinkValue(c)]));
    }
    if (properties.isEmpty) {
      if (!r.isNew) r.remove(NotifyNs.followProperties);
    } else {
      r.set(NotifyNs.followProperties,
          ArrayValue([for (final p in properties) LinkValue(p)]));
    }
    await r.save();
    return Follow(r);
  }

  /// Stop following [about] (follows above it still count).
  Future<void> unfollow(String about) async {
    await (await followOf(about))?.resource.destroy();
  }

  // Push.

  Future<List<String>> pushEndpoints() async => [
        for (final r in await _children(NotifyNs.pushRegistration))
          if (r.getString(NotifyNs.pushEndpoint) case final e?) e
      ];

  /// This device wants push at [endpoint] (from its push distributor).
  /// [device] names it in the list. Registering the same endpoint again
  /// changes nothing.
  Future<void> registerPush(String endpoint, {String device = 'Device'}) async {
    for (final r in await _children(NotifyNs.pushRegistration)) {
      if (r.getString(NotifyNs.pushEndpoint) == endpoint) return;
    }
    final r = store.newResource(
        parent: subject,
        isA: [NotifyNs.pushRegistration],
        props: {Props.name: device, NotifyNs.pushEndpoint: UriValue(endpoint)});
    await r.save();
  }

  Future<void> unregisterPush(String endpoint) async {
    for (final r in await _children(NotifyNs.pushRegistration)) {
      if (r.getString(NotifyNs.pushEndpoint) == endpoint) await r.destroy();
    }
  }
}

/// Tell [recipients] (agents) about [about]: an Announcement under [parent],
/// which must be somewhere they can read and the sender can write. The
/// server delivers it once to each recipient who can read it.
Future<String> announce(
  Store store, {
  required String parent,
  required String title,
  required List<String> recipients,
  String? about,
  String? body,
  bool actionRequired = false,
}) async {
  final r = store.newResource(parent: parent, isA: [
    NotifyNs.announcement
  ], props: {
    Props.name: title,
    NotifyNs.recipients: ArrayValue([for (final a in recipients) LinkValue(a)]),
    if (about != null) NotifyNs.about: LinkValue(about),
    if (body != null && body.trim().isNotEmpty)
      Props.description: StringValue(body.trim()),
    if (actionRequired) NotifyNs.actionRequired: BooleanValue(true),
  });
  await r.save();
  return r.subject;
}
