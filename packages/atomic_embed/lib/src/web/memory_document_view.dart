import 'dart:convert';
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// Where the page's memory host keeps a resource (`mockHost.ts`,
/// `MEMORY_HOST_PREFIX`): `{jsonAd, snapshot}` in the tab's sessionStorage.
const memoryHostPrefix = 'atomic-embed-memory:';

/// Puts [jsonAd] (a JSON-AD object; `@id` is set to [subject]) into the
/// page's memory store, unless the page already has the resource: what was
/// typed in it stays.
void seedMemoryResource(String subject, Map<String, Object?> jsonAd) {
  final key = '$memoryHostPrefix$subject';
  if (web.window.sessionStorage.getItem(key) != null) return;
  web.window.sessionStorage.setItem(
      key,
      jsonEncode({
        'jsonAd': {...jsonAd, '@id': subject},
        'snapshot': null,
      }));
}

/// Empties the page's memory store in this tab: for a web demo that starts
/// its own data afresh on every load, so a new resource never meets the text
/// of an earlier one under the same subject.
void clearMemoryResources() {
  final storage = web.window.sessionStorage;
  for (var i = storage.length - 1; i >= 0; i--) {
    final key = storage.key(i);
    if (key != null && key.startsWith(memoryHostPrefix)) {
      storage.removeItem(key);
    }
  }
}

/// The Atomic editor of [subject] in an iframe, for a web build without an
/// Atomic node: the page keeps its resources and their Loro snapshots in the
/// tab's sessionStorage and signs with an agent of its own. Writing works and
/// survives closing and opening the editor; nothing syncs to other devices,
/// and the tab's storage ends with the tab. Seed the resource first with
/// [seedMemoryResource].
///
/// [page] is the bundle's `embed.html` as the web app serves it; for an
/// asset `assets/embed/embed.html` of the app that is
/// `assets/assets/embed/embed.html`.
class MemoryDocumentView extends StatefulWidget {
  const MemoryDocumentView({
    super.key,
    required this.subject,
    this.page = 'assets/assets/embed/embed.html',
  });

  final String subject;
  final String page;

  /// The iframe's address: the one resource, locked, from the memory host.
  static Uri url(String page, String subject, Brightness brightness) =>
      Uri.parse(page).replace(queryParameters: {
        'subject': subject,
        'lock': '1',
        'host': 'memory',
        'scheme': brightness == Brightness.dark ? 'dark' : 'light',
      });

  @override
  State<MemoryDocumentView> createState() => _MemoryDocumentViewState();
}

class _MemoryDocumentViewState extends State<MemoryDocumentView> {
  static var _next = 0;
  String? _viewType;
  Brightness? _brightness;

  void _register(Brightness brightness) {
    _brightness = brightness;
    final viewType = 'atomic-memory-document-${_next++}';
    final src = MemoryDocumentView.url(widget.page, widget.subject, brightness)
        .toString();
    ui_web.platformViewRegistry.registerViewFactory(viewType, (int _) {
      final frame = web.HTMLIFrameElement()
        ..src = src
        ..style.border = 'none'
        ..style.width = '100%'
        ..style.height = '100%';
      return frame;
    });
    _viewType = viewType;
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    if (_viewType == null || brightness != _brightness) _register(brightness);
    return HtmlElementView(key: ValueKey(_viewType), viewType: _viewType!);
  }

  @override
  void didUpdateWidget(MemoryDocumentView old) {
    super.didUpdateWidget(old);
    if (old.subject != widget.subject || old.page != widget.page) {
      _viewType = null;
    }
  }
}
