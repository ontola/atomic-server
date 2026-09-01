/// Generic lock-screen copy. Keep in sync with hub `visible_body_for_type`.
({String title, String body}) visiblePushCopy(String type) {
  const title = 'Atomic';
  switch (type) {
    case 'mention':
      return (title: title, body: 'Someone mentioned you');
    case 'message':
      return (title: title, body: 'You have a new message');
    case 'access-request':
      return (title: title, body: 'Someone requested access');
    case 'watch-membership':
      return (title: title, body: 'A list you follow changed');
    case 'watch-content':
      return (title: title, body: 'Something you follow was updated');
    default:
      return (title: title, body: 'You have a new notification');
  }
}

String? aboutFromPushData(Map<String, dynamic>? data) {
  if (data == null) return null;
  final about = data['about'];
  if (about is String && about.isNotEmpty) return about;
  return null;
}

String typeFromPushData(Map<String, dynamic>? data) {
  if (data == null) return 'mention';
  final type = data['type'] ?? data['notificationType'];
  if (type is String && type.isNotEmpty) return type;
  return 'mention';
}
