import 'resource.dart';
import 'store.dart';
import 'urls.dart';

/// [Store.registerApp]: an app announces itself in a drive.
extension RegisterApp on Store {
  /// Record that this app uses [drive], as a [Classes.externalApp] child of
  /// it, so the web app can list the app under the drive's settings and offer
  /// "Open in [name]" on resources of a class in [handlesClasses].
  ///
  /// Call it when the app starts. It is idempotent: the app is recognised by
  /// its [homepage] (compared without a trailing slash), and an existing
  /// registration is updated only where something differs, so a repeated call
  /// writes nothing.
  ///
  /// [openUrlTemplate] is a URL with `{subject}` where the URL-encoded subject
  /// of the resource goes, e.g. `https://openmeeting.nl/open?subject={subject}`.
  /// [handlesClasses] are class URLs, e.g. `https://openmeeting.nl/ns/classes/Gremium`.
  ///
  /// Throws [StoreException] when it cannot write, notably
  /// [StoreErrorKind.unauthorized] when the agent may not append to [drive]
  /// (a read-only member): the app decides whether to carry on without being
  /// listed. Returns the registration.
  Future<Resource> registerApp({
    required String drive,
    required String name,
    required String homepage,
    String? emoji,
    String? description,
    String? openUrlTemplate,
    List<String> handlesClasses = const [],
  }) async {
    final driveResource = await getResource(drive, fresh: true);
    final children = await driveResource.children();
    final key = _homepageKey(homepage);

    Resource? existing;
    for (final child in children) {
      if (child.isA(Classes.externalApp) &&
          _homepageKey(child.getString(Props.homepage) ?? '') == key) {
        existing = child;
        break;
      }
    }

    final app = existing ??
        newResource(parent: drive, isA: [Classes.externalApp]);

    void sync(String property, String? wanted) {
      if (wanted == null) {
        if (app.get(property) != null) app.remove(property);
      } else if (app.getString(property) != wanted) {
        app.set(property, wanted);
      }
    }

    sync(Props.name, name);
    sync(Props.homepage, homepage);
    sync(Props.emoji, emoji);
    sync(Props.description, description);
    sync(Props.openUrlTemplate, openUrlTemplate);

    final current = app.getLinks(Props.handlesClasses);
    if (existing == null || !_sameList(current, handlesClasses)) {
      if (handlesClasses.isEmpty) {
        if (app.get(Props.handlesClasses) != null) {
          app.remove(Props.handlesClasses);
        }
      } else {
        app.set(Props.handlesClasses, handlesClasses);
      }
    }

    await app.save();
    return app;
  }
}

String _homepageKey(String url) => url.trim().replaceFirst(RegExp(r'/+$'), '');

bool _sameList(List<String> a, List<String> b) =>
    a.length == b.length && Iterable<int>.generate(a.length).every((i) => a[i] == b[i]);
