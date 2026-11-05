/// The Atomic web renderer in a Flutter web view: the page and its channel
/// ([WebViewEmbedPage]), the local server of its files ([EmbedServer]), and
/// one resource shown on its own ([AtomicDocumentView]), and a meeting's
/// audio and video call over the app ([MeetingCall], [MeetingCallOverlay]).
///
/// The host app ships the renderer's files (`flutter/scripts/build_embed.sh`
/// builds them) and answers the page's store calls, for example with
/// `AtomicStore.embedCall` of `atomic_store_flutter`.
library;

export 'src/call_permissions.dart';
export 'src/document_view.dart';
export 'src/embed_page.dart';
export 'src/embed_server.dart';
export 'src/meeting_call.dart';
export 'src/meeting_call_overlay.dart';
