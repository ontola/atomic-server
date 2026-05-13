#!/bin/bash
# Simple proxy that adds cross-origin isolation headers to Flutter's web dev server.
# Usage: ./web_proxy.sh <flutter_port> <proxy_port>
# Then open http://localhost:<proxy_port> in the browser.

FLUTTER_PORT=${1:-65423}
PROXY_PORT=${2:-8080}

echo "Proxying localhost:$PROXY_PORT -> localhost:$FLUTTER_PORT (with COOP/COEP headers)"
echo "Open http://localhost:$PROXY_PORT in your browser"

# Use socat or a simple node proxy. Let's try with a tiny Dart script.
FLUTTER="$HOME/.local/share/mise/installs/flutter/3.22.1-stable/bin"
"$FLUTTER/dart" run --define=FLUTTER_PORT=$FLUTTER_PORT --define=PROXY_PORT=$PROXY_PORT /dev/stdin << 'DART'
import 'dart:io';

void main() async {
  final flutterPort = int.parse(const String.fromEnvironment('FLUTTER_PORT', defaultValue: '65423'));
  final proxyPort = int.parse(const String.fromEnvironment('PROXY_PORT', defaultValue: '8080'));

  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, proxyPort);
  print('COOP/COEP proxy listening on http://localhost:$proxyPort');

  final client = HttpClient();

  await for (final request in server) {
    try {
      final proxyReq = await client.openUrl(
        request.method,
        Uri.parse('http://localhost:$flutterPort${request.uri}'),
      );

      request.headers.forEach((name, values) {
        for (final v in values) {
          proxyReq.headers.add(name, v);
        }
      });

      final proxyResp = await proxyReq.close();

      request.response.statusCode = proxyResp.statusCode;
      proxyResp.headers.forEach((name, values) {
        for (final v in values) {
          request.response.headers.add(name, v);
        }
      });

      // Add cross-origin isolation headers
      request.response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      request.response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

      await proxyResp.pipe(request.response);
    } catch (e) {
      request.response.statusCode = 502;
      request.response.write('Proxy error: $e');
      await request.response.close();
    }
  }
}
DART
