import 'dart:convert';

import 'package:calorie_tracker/screens/openrouter_screen.dart';
import 'package:calorie_tracker/services/openrouter.dart';
import 'package:calorie_tracker/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The settings screen, driven the way it is used: paste a key, pick a model.
///
/// Signing in cannot be tested here — it hands off to a browser — which is
/// most of why the pasted key is worth having.
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });

  /// The account answers key checks with [keyStatus]; the screen's client
  /// answers the catalogue.
  Future<OpenRouterAccount> pump(
    WidgetTester tester, {
    int keyStatus = 200,
    String keyBody = '{"data": {}}',
  }) async {
    final account = OpenRouterAccount(
      httpClient: MockClient((_) async => http.Response(keyBody, keyStatus)),
    );
    await account.load();

    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.dark),
      home: OpenRouterScreen(
        account: account,
        client: OpenRouterClient(
          account: account,
          httpClient: MockClient((_) async => http.Response(_catalogue, 200)),
        ),
      ),
    ));
    await tester.pumpAndSettle();

    return account;
  }

  Future<void> pasteKey(WidgetTester tester, String key) async {
    await tester.tap(find.text('Paste a key instead'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'API key'), key);
    await tester.tap(find.text('Save key'));
    await tester.pumpAndSettle();
  }

  testWidgets('a key can be pasted instead of signing in', (tester) async {
    final account = await pump(tester);

    expect(find.text('Not connected'), findsOneWidget);
    await pasteKey(tester, 'sk-or-typed');

    expect(account.apiKey, 'sk-or-typed');
    expect(find.text('Connected to OpenRouter'), findsOneWidget);
    expect(
      find.widgetWithText(TextField, 'API key'),
      findsNothing,
      reason: 'the field has done its job and the key is not left on screen',
    );
  });

  testWidgets('a key that does not work says so, and stays put', (tester) async {
    final account = await pump(
      tester,
      keyStatus: 401,
      keyBody: jsonEncode({'error': {'message': 'User not found.'}}),
    );

    await pasteKey(tester, 'sk-or-wrong');

    expect(find.text('User not found.'), findsOneWidget);
    expect(account.isConnected, isFalse);
    expect(
      find.text('sk-or-wrong'),
      findsOneWidget,
      reason: 'what was typed is still there to be corrected',
    );
  });

  /// Obscured by default, because this is a credential on a screen someone may
  /// be showing to somebody.
  testWidgets('the key is hidden until asked for', (tester) async {
    await pump(tester);
    await tester.tap(find.text('Paste a key instead'));
    await tester.pumpAndSettle();

    TextField field() => tester.widget(find.widgetWithText(TextField, 'API key'));
    expect(field().obscureText, isTrue);

    await tester.tap(find.byIcon(Icons.visibility_off));
    await tester.pumpAndSettle();

    expect(field().obscureText, isFalse);
  });

  testWidgets('cancelling forgets what was typed', (tester) async {
    await pump(tester);
    await tester.tap(find.text('Paste a key instead'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'API key'), 'sk-or-typed');

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(find.text('sk-or-typed'), findsNothing);
    expect(find.text('Paste a key instead'), findsOneWidget);
  });

  testWidgets('picking a model keeps it', (tester) async {
    final account = await pump(tester);

    await tester.tap(find.text('Cheap Vision'));
    await tester.pumpAndSettle();

    expect(account.model, 'someone/cheap-vision');

    final reopened = OpenRouterAccount();
    await reopened.load();
    expect(reopened.model, 'someone/cheap-vision');
  });
}

final _catalogue = jsonEncode({
  'data': [
    {
      'id': 'openai/gpt-5.6-luna',
      'name': 'GPT-5.6 Luna',
      'architecture': {
        'input_modalities': ['image', 'text'],
      },
      'supported_parameters': ['structured_outputs'],
      'pricing': {'prompt': '0.0000001', 'completion': '0.0000006'},
    },
    {
      'id': 'someone/cheap-vision',
      'name': 'Cheap Vision',
      'architecture': {
        'input_modalities': ['image', 'text'],
      },
      'supported_parameters': ['structured_outputs'],
      'pricing': {'prompt': '0.00000001', 'completion': '0.00000002'},
    },
  ],
});
