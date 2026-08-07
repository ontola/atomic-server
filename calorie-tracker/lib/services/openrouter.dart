import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/meal.dart';

/// Everything this app says to OpenRouter: signing in, listing the models that
/// can see, and asking one of them what a meal was.
///
/// All of it is plain HTTPS, which is why it lives in Dart rather than behind
/// the bridge (`planning/calorie-tracker-plan.md` §2) — and it keeps the Rust
/// crate app-agnostic, which is what lets it merge with the canvas app's.

const _apiBase = 'https://openrouter.ai/api/v1';
const _authEndpoint = 'https://openrouter.ai/auth';

/// The custom scheme the OAuth redirect comes back on. Registered in
/// `android/app/src/main/AndroidManifest.xml`; iOS needs nothing, because
/// `ASWebAuthenticationSession` is told the scheme at call time.
const _callbackScheme = 'caltracker';
const _callbackUrl = '$_callbackScheme://oauth';

// ── Errors ─────────────────────────────────────────────────────────────────

/// Something OpenRouter would not do.
///
/// [retryable] is the only thing the queue asks of it, and it is a judgement
/// about *this* call rather than about the meal: a rate limit or a dead socket
/// is worth another go in a moment, a rejected key or an answer that does not
/// match the schema is not — the same request would fail the same way, and each
/// attempt costs money.
class OpenRouterException implements Exception {
  const OpenRouterException(this.message, {this.statusCode, this.retryable = false});

  final String message;
  final int? statusCode;
  final bool retryable;

  @override
  String toString() => message;
}

// ── Models ─────────────────────────────────────────────────────────────────

/// A model on OpenRouter, as far as this app cares.
class OpenRouterModel {
  const OpenRouterModel({
    required this.id,
    required this.name,
    required this.seesImages,
    required this.followsSchemas,
    required this.promptPricePerToken,
    required this.completionPricePerToken,
  });

  factory OpenRouterModel.fromJson(Map<String, dynamic> json) {
    final architecture = json['architecture'];
    final modalities = architecture is Map
        ? (architecture['input_modalities'] as List?) ?? const []
        : const [];
    final parameters = (json['supported_parameters'] as List?) ?? const [];
    final pricing = json['pricing'];

    return OpenRouterModel(
      id: json['id'] as String,
      name: (json['name'] as String?) ?? json['id'] as String,
      seesImages: modalities.contains('image'),
      followsSchemas: parameters.contains('structured_outputs'),
      promptPricePerToken: _price(pricing, 'prompt'),
      completionPricePerToken: _price(pricing, 'completion'),
    );
  }

  final String id;
  final String name;

  /// Whether it takes an image at all — the one hard requirement, since most
  /// meals arrive as a photograph and nothing else.
  final bool seesImages;

  /// Whether it honours `response_format: json_schema`. Not required: models
  /// without it usually still return the JSON they were asked for, and the
  /// parser has to survive a bad answer either way. Shown in the picker so an
  /// unreliable choice is a visible one.
  final bool followsSchemas;

  /// Dollars per token, which is how OpenRouter quotes it.
  final double promptPricePerToken;
  final double completionPricePerToken;

  /// What a meal costs, near enough to compare two models with: ~1040 visual
  /// tokens for a 1024px photo (plan §6), a couple of hundred of prompt and
  /// answer around it.
  double get dollarsPerMeal =>
      1400 * promptPricePerToken + 200 * completionPricePerToken;

  static double _price(Object? pricing, String key) {
    if (pricing is! Map) return 0;
    final value = pricing[key];
    if (value is num) return value.toDouble();
    return double.tryParse('$value') ?? 0;
  }
}

// ── The account ────────────────────────────────────────────────────────────

/// The key, and which model to spend it on.
///
/// The key is the sensitive half and lives in the platform keychain next to the
/// agent secret (`AtomicSession` keeps that one there, for the same reason).
/// The model id is a preference.
class OpenRouterAccount extends ChangeNotifier {
  OpenRouterAccount({
    http.Client? httpClient,
    FlutterSecureStorage secureStorage = const FlutterSecureStorage(
      aOptions: AndroidOptions(encryptedSharedPreferences: true),
    ),
  })  : _http = httpClient ?? http.Client(),
        _secure = secureStorage;

  final http.Client _http;
  final FlutterSecureStorage _secure;

  /// Cheap, fast, sees images and follows a schema — which is the whole job.
  /// Settings can change it; nothing else in the app names a model.
  static const defaultModel = 'openai/gpt-5.6-luna';

  /// A key baked in at build time, for developing against a real model without
  /// signing in on every fresh simulator:
  ///
  /// ```sh
  /// flutter run --dart-define=OPENROUTER_API_KEY=$OPENROUTER_API_KEY
  /// ```
  ///
  /// `make ios` / `make android` pass it through from the environment when it
  /// is set. It is the *fallback*: a key someone signed in with on the device
  /// always wins, so a dev build does not quietly bill the wrong account.
  static const _buildKey = String.fromEnvironment('OPENROUTER_API_KEY');

  static const _keyStorageKey = 'openrouter_api_key';
  static const _modelStorageKey = 'openrouter_model';

  String? _storedKey;
  String _model = defaultModel;
  bool _loaded = false;
  bool _connecting = false;

  /// The key to send, or null when there is none to send.
  String? get apiKey {
    final stored = _storedKey;
    if (stored != null && stored.isNotEmpty) return stored;
    return _buildKey.isEmpty ? null : _buildKey;
  }

  bool get isConnected => apiKey != null;

  /// Whether the key in use is the build-time one rather than one the user
  /// signed in with. Worth saying out loud on the settings screen: it works
  /// here and will not work in anyone else's build.
  bool get usingBuildKey =>
      (_storedKey == null || _storedKey!.isEmpty) && _buildKey.isNotEmpty;

  /// Whether the account has been read off the device yet. Screens that would
  /// otherwise flash "not connected" at a connected user wait for this.
  bool get loaded => _loaded;

  bool get connecting => _connecting;

  String get model => _model;

  Future<void> load() async {
    _storedKey = await _secure.read(key: _keyStorageKey);
    final prefs = await SharedPreferences.getInstance();
    _model = prefs.getString(_modelStorageKey) ?? defaultModel;
    _loaded = true;
    notifyListeners();
  }

  Future<void> setModel(String id) async {
    if (id.isEmpty || id == _model) return;
    _model = id;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_modelStorageKey, id);
  }

  /// Sign in with OpenRouter's PKCE flow and keep the key it hands back.
  ///
  /// PKCE because there is no client secret to hide in an app anybody can
  /// unzip: the app proves it started the flow by producing the verifier its
  /// challenge was derived from. Throws [OpenRouterException] with something
  /// worth showing when it does not work out.
  Future<void> connect() async {
    if (_connecting) return;
    _connecting = true;
    notifyListeners();
    try {
      final verifier = _codeVerifier();
      final url = Uri.parse(_authEndpoint).replace(queryParameters: {
        'callback_url': _callbackUrl,
        'code_challenge': _codeChallenge(verifier),
        'code_challenge_method': 'S256',
      });

      final String redirected;
      try {
        redirected = await FlutterWebAuth2.authenticate(
          url: url.toString(),
          callbackUrlScheme: _callbackScheme,
        );
      } on PlatformException catch (e) {
        // Closing the browser is the ordinary way out of a sign-in, not a
        // failure to report.
        if (e.code == 'CANCELED') return;
        rethrow;
      }

      final code = Uri.parse(redirected).queryParameters['code'];
      if (code == null || code.isEmpty) {
        throw const OpenRouterException('OpenRouter sent no code back');
      }

      _storedKey = await _exchange(code, verifier);
      await _secure.write(key: _keyStorageKey, value: _storedKey);
    } finally {
      _connecting = false;
      notifyListeners();
    }
  }

  /// Keep a key the user pasted in, once OpenRouter agrees it is one.
  ///
  /// The other way in, for anyone who would rather make a key on
  /// openrouter.ai/keys than hand this app an OAuth session — and the only way
  /// in on a desktop or a simulator where the browser round trip is awkward.
  ///
  /// It is checked before it is stored because the alternative is silence: a
  /// mistyped key does nothing at all until the next meal, which then fails on
  /// a 401 the queue will not retry.
  Future<void> useKey(String key) async {
    if (_connecting) return;
    final trimmed = key.trim();
    if (trimmed.isEmpty) {
      throw const OpenRouterException('No key to save');
    }

    _connecting = true;
    notifyListeners();
    try {
      await _verify(trimmed);
      _storedKey = trimmed;
      await _secure.write(key: _keyStorageKey, value: trimmed);
    } finally {
      _connecting = false;
      notifyListeners();
    }
  }

  /// Ask OpenRouter who this key belongs to. Anything but a 200 means it is not
  /// a key that works, whatever the reason.
  Future<void> _verify(String key) async {
    final http.Response response;
    try {
      response = await _http.get(
        Uri.parse('$_apiBase/key'),
        headers: {'Authorization': 'Bearer $key'},
      );
    } on SocketException catch (e) {
      throw OpenRouterException('No connection to OpenRouter: ${e.message}');
    } on http.ClientException catch (e) {
      throw OpenRouterException('Could not reach OpenRouter: ${e.message}');
    }

    if (response.statusCode == 200) return;
    throw OpenRouterException(
      _errorMessage(_decode(response.body)) ?? 'OpenRouter would not take that key',
      statusCode: response.statusCode,
    );
  }

  /// Trade the single-use code for a key. Codes are single-use, so this runs
  /// exactly once per [connect] — a retry needs a whole new round trip.
  Future<String> _exchange(String code, String verifier) async {
    final response = await _http.post(
      Uri.parse('$_apiBase/auth/keys'),
      headers: const {'Content-Type': 'application/json'},
      body: jsonEncode({
        'code': code,
        'code_verifier': verifier,
        'code_challenge_method': 'S256',
      }),
    );

    final body = _decode(response.body);
    final key = body?['key'];
    if (response.statusCode != 200 || key is! String || key.isEmpty) {
      throw OpenRouterException(
        _errorMessage(body) ?? 'OpenRouter did not return an API key',
        statusCode: response.statusCode,
      );
    }
    return key;
  }

  /// Forget the key on this device. The key itself stays valid — revoking it is
  /// something only openrouter.ai can do, and the settings screen says so.
  Future<void> disconnect() async {
    await _secure.delete(key: _keyStorageKey);
    _storedKey = null;
    notifyListeners();
  }

  /// 43 characters of unreserved alphabet, which is the shortest RFC 7636
  /// allows. `Random.secure` because a guessable verifier is the one thing PKCE
  /// is protecting.
  static String _codeVerifier() {
    const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    final random = Random.secure();
    return List.generate(
      43,
      (_) => alphabet[random.nextInt(alphabet.length)],
    ).join();
  }

  static String _codeChallenge(String verifier) =>
      base64Url.encode(sha256.convert(utf8.encode(verifier)).bytes).replaceAll('=', '');
}

// ── The client ─────────────────────────────────────────────────────────────

/// The two calls this app makes: what can you see, and what is this.
class OpenRouterClient {
  OpenRouterClient({required OpenRouterAccount account, http.Client? httpClient})
      : _account = account,
        _http = httpClient ?? http.Client();

  final OpenRouterAccount _account;
  final http.Client _http;

  /// Sent so this app shows up by name on the user's OpenRouter activity page,
  /// which is where they would go to work out what has been spending their
  /// money.
  static const _headers = {'X-Title': 'Calorie Tracker'};

  /// Every model that can look at a photo, cheapest first.
  ///
  /// Public — no key needed — so the picker works before anyone has signed in,
  /// which is the order the settings screen puts them in anyway.
  Future<List<OpenRouterModel>> visionModels() async {
    final response = await _get('$_apiBase/models');
    final data = response['data'];
    if (data is! List) {
      throw const OpenRouterException('OpenRouter listed no models');
    }

    final models = data
        .whereType<Map<String, dynamic>>()
        .map(OpenRouterModel.fromJson)
        .where((m) => m.seesImages)
        .toList()
      ..sort((a, b) => a.dollarsPerMeal.compareTo(b.dollarsPerMeal));
    return models;
  }

  /// What was this, and how many calories.
  ///
  /// [photo] is the stored image straight off disk — already the compressed
  /// 1024px version (plan §6), which is what makes this call cost a fraction of
  /// a cent. [words] is what the user typed, and is the whole input for a meal
  /// that was never photographed.
  ///
  /// [prior] is what the eater wrote about a *different, similar* meal —
  /// Phase 7.4's medium band (`calorie-tracker-embeddings.md` §3). It is
  /// `meal-notes` and only ever `meal-notes`: a `description` or a `name` fed
  /// forward would be the model's own words handed back to it as a human's,
  /// which is the failure Phase 5 exists to prevent. `MealPriors` is where that
  /// is enforced; this end only has to keep the two apart in the prompt, because
  /// they are different claims — one is about this meal and one is not.
  Future<MealEstimate> estimate({
    Uint8List? photo,
    String photoPath = '',
    String words = '',
    String prior = '',
    String? model,
  }) async {
    if (photo == null && words.trim().isEmpty) {
      throw const OpenRouterException(
        'Nothing to estimate — no photo and nothing written down',
      );
    }

    final key = _account.apiKey;
    if (key == null) {
      throw const OpenRouterException('Not connected to OpenRouter');
    }
    final modelId = model ?? _account.model;

    final content = <Map<String, dynamic>>[
      {'type': 'text', 'text': _userPrompt(words, prior)},
      if (photo != null)
        {
          'type': 'image_url',
          'image_url': {
            'url': 'data:${mimeTypeOf(photoPath)};base64,${base64Encode(photo)}',
          },
        },
    ];

    final response = await _post(
      '$_apiBase/chat/completions',
      key: key,
      body: {
        'model': modelId,
        'messages': [
          {'role': 'system', 'content': _systemPrompt},
          {'role': 'user', 'content': content},
        ],
        'response_format': _responseFormat,
      },
    );

    return _readEstimate(response, modelId);
  }

  // ── The wire ─────────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> _get(String url) =>
      _send(() => _http.get(Uri.parse(url), headers: _headers));

  Future<Map<String, dynamic>> _post(
    String url, {
    required String key,
    required Map<String, dynamic> body,
  }) =>
      _send(() => _http.post(
            Uri.parse(url),
            headers: {
              ..._headers,
              'Authorization': 'Bearer $key',
              'Content-Type': 'application/json',
            },
            body: jsonEncode(body),
          ));

  Future<Map<String, dynamic>> _send(Future<http.Response> Function() call) async {
    final http.Response response;
    try {
      response = await call();
    } on SocketException catch (e) {
      // No network is the most ordinary failure there is, and the most worth
      // another go in a minute.
      throw OpenRouterException('No connection to OpenRouter: ${e.message}',
          retryable: true);
    } on http.ClientException catch (e) {
      throw OpenRouterException('OpenRouter call failed: ${e.message}',
          retryable: true);
    }

    final body = _decode(response.body);

    // OpenRouter reports upstream provider failures inside a 200 as well as by
    // status code, so both paths have to be read.
    final error = _errorMessage(body);
    if (response.statusCode != 200 || error != null) {
      final code = _errorCode(body) ?? response.statusCode;
      throw OpenRouterException(
        error ?? 'OpenRouter returned ${response.statusCode}',
        statusCode: code,
        retryable: _worthRetrying(code),
      );
    }

    if (body == null) {
      throw const OpenRouterException('OpenRouter returned something that is not JSON');
    }
    return body;
  }

  /// Rate limits and the provider having a bad minute pass; a rejected key or a
  /// malformed request will fail the same way however often it is sent.
  static bool _worthRetrying(int code) =>
      code == 408 || code == 429 || code >= 500;

  // ── The answer ───────────────────────────────────────────────────────────

  /// Pull the estimate out of a chat completion.
  ///
  /// Everything wrong here is deliberately *not* retryable: a model that just
  /// broke a strict schema will break it again, and every attempt is billed.
  /// The meal fails, keeps its photo, and the user can retry it by hand.
  static MealEstimate _readEstimate(Map<String, dynamic> response, String model) {
    final choices = response['choices'];
    final message = choices is List && choices.isNotEmpty && choices.first is Map
        ? (choices.first as Map)['message']
        : null;
    final content = message is Map ? message['content'] : null;
    if (content is! String || content.trim().isEmpty) {
      throw const OpenRouterException('The model answered with nothing');
    }

    final json = _decode(content);
    if (json == null) {
      throw const OpenRouterException(
        'The model did not answer with the JSON it was asked for',
      );
    }

    final calories = _int(json['calories']);
    if (calories == null) {
      throw const OpenRouterException('The model gave no calorie count');
    }

    final question = _string(json['clarifying_question']).trim();

    return MealEstimate(
      name: _string(json['name']).trim(),
      description: _string(json['description']).trim(),
      calories: calories < 0 ? 0 : calories,
      caloriesMin: _int(json['calories_min']),
      caloriesMax: _int(json['calories_max']),
      confidence: MealConfidence.fromWire(_string(json['confidence']).trim()),
      model: model,
      clarifyingQuestion: question,
      proteinGrams: _double(json['protein_g']),
      carbsGrams: _double(json['carbs_g']),
      fatGrams: _double(json['fat_g']),
    );
  }

  // ── The prompt ───────────────────────────────────────────────────────────

  static const _systemPrompt = '''
You estimate how much energy is in a meal, from a photograph of it, from a
description of it, or from both.

Estimate the portion from what is around it — the plate, the cutlery, the cup,
a hand. Say what you actually see rather than what a dish of that name usually
weighs; a "salad" can be 80 kcal or 900.

Give a range you would stand behind, not a token one: `calories_min` and
`calories_max` should be far apart when the picture leaves the portion or the
ingredients genuinely open.

Ask a `clarifying_question` only when one answer would move the estimate a lot
and you cannot tell from what you were given — a glass of white liquid is milk
or oat milk or a protein shake, and those are 100 kcal apart. Otherwise leave it
null. Do not ask for something the user has already told you, here or about a
similar meal they have logged before.

You may be shown what this person wrote about an earlier meal that looked like
this one. It is background about how they usually eat, not a description of what
is in front of you: use it where it fits what you can see, and ignore it where it
does not.

Answer only with the JSON object you were given a schema for.''';

  /// The question, then what is known about this meal, then what is known about
  /// meals like it — each labelled as what it is.
  ///
  /// The labels are the whole design. Merging the prior into the same sentence
  /// as [words] would tell the model that somebody said this about *this* plate,
  /// which is the one thing that is not true about it.
  static String _userPrompt(String words, String prior) {
    final parts = ['What is in this, and how many calories?'];

    final wrote = words.trim();
    if (wrote.isNotEmpty) parts.add('The person who logged it wrote: "$wrote"');

    final earlier = prior.trim();
    if (earlier.isNotEmpty) {
      parts.add('About a similar meal they logged before, the same person '
          'wrote: "$earlier"');
    }

    return parts.join('\n\n');
  }

  /// `strict: true` needs every property listed in `required`, so the optional
  /// ones are nullable rather than absent.
  static const _responseFormat = {
    'type': 'json_schema',
    'json_schema': {
      'name': 'meal_estimate',
      'strict': true,
      'schema': {
        'type': 'object',
        'properties': {
          'name': {
            'type': 'string',
            'description': 'What this is, as someone would say it. A few words.',
          },
          'description': {
            'type': 'string',
            'description':
                'What you can see and what size you took it to be — one or two sentences.',
          },
          'calories': {'type': 'integer', 'description': 'Best estimate, kcal.'},
          'calories_min': {'type': 'integer'},
          'calories_max': {'type': 'integer'},
          'protein_g': {'type': ['number', 'null']},
          'carbs_g': {'type': ['number', 'null']},
          'fat_g': {'type': ['number', 'null']},
          'confidence': {
            'type': 'string',
            'enum': ['high', 'medium', 'low'],
          },
          'clarifying_question': {
            'type': ['string', 'null'],
            'description':
                'The one thing you could not tell that would change the estimate, or null.',
          },
        },
        'required': [
          'name',
          'description',
          'calories',
          'calories_min',
          'calories_max',
          'protein_g',
          'carbs_g',
          'fat_g',
          'confidence',
          'clarifying_question',
        ],
        'additionalProperties': false,
      },
    },
  };
}

// ── Odds and ends ──────────────────────────────────────────────────────────

/// The mime type of a stored photo, from its extension.
///
/// Driven by the path rather than by a constant so a store holding both JPEGs
/// and something else stays valid — which is what makes the WebP question
/// (plan §6.1, §10) a change to `ImageStore` alone.
String mimeTypeOf(String path) {
  switch (p.extension(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

Map<String, dynamic>? _decode(String body) {
  try {
    final decoded = jsonDecode(body);
    return decoded is Map<String, dynamic> ? decoded : null;
  } on FormatException {
    return null;
  }
}

/// OpenRouter's errors are `{error: {message, code}}`, and occasionally just a
/// string.
String? _errorMessage(Map<String, dynamic>? body) {
  final error = body?['error'];
  if (error == null) return null;
  if (error is String) return error.isEmpty ? null : error;
  if (error is Map) {
    final message = error['message'];
    if (message is String && message.isNotEmpty) return message;
    return 'OpenRouter refused the request';
  }
  return null;
}

int? _errorCode(Map<String, dynamic>? body) {
  final error = body?['error'];
  return error is Map ? _int(error['code']) : null;
}

String _string(Object? value) => value is String ? value : '';

int? _int(Object? value) {
  if (value is int) return value;
  if (value is num) return value.round();
  if (value is String) return int.tryParse(value) ?? double.tryParse(value)?.round();
  return null;
}

double? _double(Object? value) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value);
  return null;
}
