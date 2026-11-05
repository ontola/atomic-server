/// The Atomic web renderer in a Flutter web app: the same page as on the
/// devices, in an iframe, with the page's own memory store (`?host=memory`).
/// Import this library only in a web build; `atomic_embed.dart` is for the
/// device apps (it needs a native web view and a local server).
library;

export 'src/web/memory_document_view.dart';
