import 'dart:async';
import 'dart:convert';

import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'chat_parts.dart';
import 'models.dart';
import 'web_tool_bridge.dart';

/// What the model is told before the conversation. Not shown to the person.
const _systemPrompt =
    'You are the assistant in atomic.place. Answer briefly and clearly, in the '
    'language the person writes in. Use Markdown where it helps.';

/// Added to [_systemPrompt] when the model is given tools.
const _toolsPrompt =
    ' When the person asks about their own data, use the tools to search '
    'their drives and read resources; link a resource as [title](subject).';

/// What the model is told to name a chat (the web app's title prompt, without
/// the emoji).
const _titlePrompt =
    'You are a specialized AI system that generates titles for AI '
    'conversations. You will be given the first part of a conversation '
    'between the user and an AI assistant. Think of a short title that fits '
    'the given conversation. This title will be shown in the UI as the title '
    'of the conversation. ALWAYS write the title in the same natural language '
    "as the user's own message text. Respond with exactly one line: the title "
    'text. Do not wrap it in JSON, quotes, markdown, or commentary.';

/// The OpenAI-compatible `chat/completions` stream, chunk by chunk (the
/// decoded JSON of each `data:` line): [messages] may carry tool calls and
/// results, [tools] the functions the model may call.
typedef CompletionChunks = Stream<Map<String, dynamic>> Function(
  List<Map<String, dynamic>> messages,
  String model,
  List<Map<String, dynamic>>? tools,
);

/// [CompletionChunks] for the chat the answer belongs to: [chat] is its
/// subject (sent to the provider as `X-Atomic-Chat`), null when there is none.
typedef ChatCompletionChunks = Stream<Map<String, dynamic>> Function(
  List<Map<String, dynamic>> messages,
  String model,
  List<Map<String, dynamic>>? tools,
  String? chat,
);

/// A function the model may call while it answers; this app runs it and
/// gives the model its result (as the web app's chat does: the account's AI
/// only passes the calls on).
class AiTool {
  /// The function's name, the same as the web app's tool of that name.
  final String name;
  final String description;

  /// The JSON Schema of its input.
  final Map<String, dynamic> parameters;

  /// Runs the call with the model's [input]; the result goes back to the
  /// model as JSON. A thrown error goes back as the call's failure.
  final Future<Object?> Function(Map<String, dynamic> input) execute;

  /// The result is text that goes to the model as it is (a web tool's), not
  /// to be encoded as JSON.
  final bool rawResult;

  const AiTool({
    required this.name,
    required this.description,
    required this.parameters,
    required this.execute,
    this.rawResult = false,
  });

  /// [def] (a tool of the web app), run by [bridge]: `{name, args}` goes to
  /// the web page and its text comes back. A result of the form
  /// `{"error": …}` is the call's failure.
  factory AiTool.web(ToolDef def, WebToolBridge bridge) => AiTool(
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        rawResult: true,
        execute: (input) async {
          final text = await bridge.run(def.name, input);
          final error = _errorOf(text);
          if (error != null) throw StateError(error);
          return text;
        },
      );

  /// The definition the model is given.
  Map<String, dynamic> get definition => {
        'type': 'function',
        'function': {
          'name': name,
          'description': description,
          'parameters': parameters,
        },
      };
}

/// What happens while the model answers.
sealed class AiEvent {
  const AiEvent();
}

/// More text of the answer.
class AiTextDelta extends AiEvent {
  final String text;
  const AiTextDelta(this.text);
}

/// What a model request used, from the `usage` chunk that ends its stream.
/// One answer can have several (one per round of tool calls).
class AiUsage extends AiEvent {
  final int promptTokens;
  final int completionTokens;

  /// What it cost, in the provider's micros; null when the chunk gives none.
  final int? costMicros;
  const AiUsage(this.promptTokens, this.completionTokens, {this.costMicros});

  /// The usage of a chunk's `usage` object (`prompt_tokens`,
  /// `completion_tokens`, `cost` in USD); null when it says nothing.
  static AiUsage? fromJson(Map usage) {
    final prompt = (usage['prompt_tokens'] as num?)?.toInt() ?? 0;
    final completion = (usage['completion_tokens'] as num?)?.toInt() ?? 0;
    final cost = usage['cost'];
    final micros = cost is num ? (cost * 1000000).round() : null;
    if (prompt == 0 && completion == 0 && micros == null) return null;
    return AiUsage(prompt, completion, costMicros: micros);
  }
}

/// Something the person should know about this answer (shown in the chat,
/// not sent to the model): the web tools could not be used.
class AiNotice extends AiEvent {
  final String text;
  const AiNotice(this.text);
}

/// The model called a tool; it runs now ([part] is `input-available`).
class AiToolStarted extends AiEvent {
  final ToolPart part;
  const AiToolStarted(this.part);
}

/// A tool call ended: [part] is `output-available` or `output-error`.
class AiToolFinished extends AiEvent {
  final ToolPart part;
  const AiToolFinished(this.part);
}

/// The included AI of a linked account: chat completions through the account
/// provider, paid from the account's credits.
class HostedAi {
  HostedAi({
    required this.status,
    Stream<String> Function(List<Map<String, String>>, String model)? stream,
    CompletionChunks? completions,
    ChatCompletionChunks? chatCompletions,
    required Future<Map<String, dynamic>> Function() enable,
    this.transcribe,
    this.voiceStatus,
    this.ownKey = false,
    this.acceptsImages = false,
    this.portal,
    this.loadModels,
  })  : assert(
            stream != null || completions != null || chatCompletions != null),
        _stream = stream,
        _chatCompletions = chatCompletions,
        _completions = completions ??
            (chatCompletions == null
                ? null
                : (m, model, tools) => chatCompletions(m, model, tools, null)),
        _enable = enable;

  /// Speech to text through the account's Whisper (a 16-bit mono PCM WAV and
  /// an optional ISO-639-1 language hint); null when not offered.
  final Future<String> Function(Uint8List wav, {String? language})? transcribe;

  /// The account's voice status (`enabled`, `remaining_micros`); null result
  /// when the portal offers none.
  final Future<Map<String, dynamic>?> Function()? voiceStatus;

  /// The AI is the person's own provider key, not the account: voice input
  /// is then transcribed through it too and costs no credits.
  final bool ownKey;

  /// Whether images may be sent to the model. The account's included AI
  /// takes text and tools only (it refuses image and file parts).
  final bool acceptsImages;

  /// Every model the account may choose (see
  /// [shared.AtomicAccountClient.aiModels]); null when not offered.
  final Future<List<shared.AtomicAiModel>?> Function()? loadModels;

  /// The account portal's origin, where credits are bought; null when not
  /// known.
  final Uri? portal;

  /// The most of a chat sent to the model: its latest messages.
  static const maxHistoryMessages = 40;
  static const maxHistoryChars = 24000;

  /// The most rounds of tool calls in one answer (as the web app's hosted
  /// chat).
  static const maxSteps = 8;

  /// How long a tool call may take before it is given up (the model is told).
  static Duration toolTimeout = const Duration(seconds: 60);

  /// How long fetching the web app's tools and prompt may take at the start of
  /// an answer (the page may still be loading) before the built-in ones are
  /// used.
  static Duration webSetupTimeout = const Duration(seconds: 30);

  /// How long the first model request waits for the web app's tools and
  /// prompt when they are not ready yet (the chat warms the page when it
  /// opens, so this is only felt on a cold page). After this the request goes
  /// with the short prompt and the built-in tools, an [AiNotice] says the
  /// web tools are missing, and the web ones are used from the next step or
  /// answer on if they come up.
  static Duration webGrace = const Duration(seconds: 10);

  /// The web chat's search tool: when the web app lacks it, the answer has
  /// no internet.
  static const webSearchTool = 'web_search_exa';

  /// How long an answer waits for the page to be read again when its tools
  /// came without [webSearchTool] (the search server connects later).
  static Duration webRetryGrace = const Duration(seconds: 3);

  /// The note shown when the web app's tools or its search are not there.
  static const webUnavailableNotice =
      'Web tools and search are unavailable for this answer.';

  /// The most of an attached text file sent to the model.
  static const maxFileChars = 20000;

  Map<String, dynamic> status;
  final Stream<String> Function(List<Map<String, String>>, String model)?
      _stream;
  final CompletionChunks? _completions;
  final ChatCompletionChunks? _chatCompletions;
  final Future<Map<String, dynamic>> Function() _enable;

  /// The provider offers AI to this account and it is switched on.
  bool get available => status['enabled'] == true;

  /// The person accepted the terms for the included AI.
  bool get consent => status['consent'] == true;

  /// Whether the model can be given tools (the stream reports tool calls).
  bool get supportsTools => _completions != null;

  /// SharedPreferences key: the model the person chose.
  static const modelKey = 'ai_model';

  /// SharedPreferences key: the label of that model.
  static const modelLabelKey = 'ai_model_label';

  /// The model the account offers by default (`model`, else the first of
  /// `models`).
  String get defaultModel =>
      status['model'] as String? ?? models.firstOrNull?.id ?? '';

  /// The models the account allows, the default first; empty when the portal
  /// lists none (only the default can be used).
  List<shared.AtomicAiModel> get models =>
      shared.AtomicAiModel.listFrom(status['models']);

  /// Whether any model may be chosen, not only [models] (`all_models`).
  bool get allModels => status['all_models'] == true;

  /// Whether there is a choice of models.
  bool get canChoose => allModels || models.length > 1;

  String? _chosen;
  String? _chosenLabel;

  bool _allowed(String id) =>
      id.isNotEmpty &&
      (allModels || id == defaultModel || models.any((m) => m.id == id));

  /// The model used: the chosen one while the account still allows it, else
  /// the default.
  String get model {
    final chosen = _chosen;
    return chosen != null && _allowed(chosen) ? chosen : defaultModel;
  }

  /// The name of [model] as the portal labels it; for a model outside
  /// [models], the label stored with the choice, else its id.
  String get modelLabel {
    final listed = models.where((m) => m.id == model).firstOrNull;
    if (listed != null) return listed.name;
    final label = _chosenLabel;
    return model == _chosen && label != null && label.isNotEmpty
        ? label
        : model;
  }

  /// Reads the stored choice (see [storedModel]).
  Future<void> restoreChoice() async {
    _chosen = await storedModel();
    _chosenLabel = await storedModelLabel();
  }

  /// Uses [id] from now on and remembers it (and its [label]); ignored when
  /// the account does not allow it.
  Future<void> choose(String id, {String? label}) async {
    if (!_allowed(id)) return;
    _chosen = id;
    _chosenLabel = label;
    await storeModel(id, label: label);
  }

  /// The model id the person chose on this device, if any.
  static Future<String?> storedModel() async {
    try {
      return (await SharedPreferences.getInstance()).getString(modelKey);
    } catch (_) {
      return null;
    }
  }

  /// The label stored with the chosen model, for one the portal's short list
  /// does not carry.
  static Future<String?> storedModelLabel() async {
    try {
      return (await SharedPreferences.getInstance()).getString(modelLabelKey);
    } catch (_) {
      return null;
    }
  }

  static Future<void> storeModel(String id, {String? label}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(modelKey, id);
      if (label == null || label.isEmpty) {
        await prefs.remove(modelLabelKey);
      } else {
        await prefs.setString(modelLabelKey, label);
      }
    } catch (_) {}
  }

  Stream<Map<String, dynamic>> _complete(
    List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>>? tools,
    String? chat,
  ) =>
      _chatCompletions != null
          ? _chatCompletions(messages, model, tools, chat)
          : _completions!(messages, model, tools);

  /// Credits left, in the provider's unit; null when it does not say.
  int? get remaining => (status['remaining_micros'] as num?)?.toInt();

  /// Where more credits are bought (the portal's dashboard, as the web app
  /// links it); null when the portal is not known. Offered even when
  /// `purchases_enabled` is false: the dashboard then explains why.
  Uri? get creditsUrl => portal?.replace(path: '/dashboard');

  /// Whether [error] says the account has no credits left (the portal's own
  /// words, as the web app matches them).
  static bool isOutOfCredits(String error) =>
      RegExp('not enough ai credits', caseSensitive: false).hasMatch(error);

  /// Why a request failed, in words for the person: the portal's message
  /// without Dart's `Bad state:` prefix.
  static String errorMessage(Object error) {
    final text = '$error'
        .replaceFirst(RegExp(r'^(Bad state|Exception|StateError): '), '')
        .trim();
    return text.isEmpty ? 'Something went wrong.' : text;
  }

  /// A short title for a chat that begins with [question] and [answer], from
  /// the model; null when it gives none.
  Future<String?> title(String question, String answer, {String? chat}) async {
    String clip(String s) => s.length > 600 ? s.substring(0, 600) : s;
    final conversation = jsonEncode([
      {'role': 'user', 'text': clip(question)},
      {'role': 'assistant', 'text': clip(answer)},
    ]);
    final prompt = 'Generate a title for the following conversation:\n'
        '```json\n$conversation\n```';
    final text = StringBuffer();
    final completions = _completions;
    if (completions != null) {
      await for (final chunk in _complete([
        {'role': 'system', 'content': _titlePrompt},
        {'role': 'user', 'content': prompt},
      ], null, chat)) {
        final choices = chunk['choices'];
        if (choices is! List || choices.isEmpty) continue;
        final delta = (choices.first as Map)['delta'];
        final content = delta is Map ? delta['content'] : null;
        if (content is String) text.write(content);
      }
    } else {
      await for (final piece in _stream!([
        {'role': 'system', 'content': _titlePrompt},
        {'role': 'user', 'content': prompt},
      ], model)) {
        text.write(piece);
      }
    }
    final line = text
        .toString()
        .replaceAll(
            RegExp(r'<think>[\s\S]*?</think>', caseSensitive: false), '')
        .replaceAll(RegExp(r'```\w*'), '')
        .trim()
        .replaceAll(RegExp(r'''^["'`]+|["'`]+$'''), '')
        .trim()
        .split(RegExp(r'\r?\n'))
        .first
        .trim();
    return line.isEmpty
        ? null
        : (line.length > 80 ? line.substring(0, 80) : line);
  }

  /// Accepts the terms; the AI can be used afterwards.
  Future<void> enable() async => status = await _enable();

  /// The answer to [history] (oldest first), as it is written.
  Stream<String> answer(List<ChatMessage> history, {String? context}) => run(
        [for (final m in history) ChatEntry.text(m)],
        context: context,
      ).where((e) => e is AiTextDelta).map((e) => (e as AiTextDelta).text);

  /// The answer to [history] (oldest first): its text as it is written, and
  /// each call to one of [tools] as it starts and ends. Calls are run here,
  /// and the model goes on with their results, at most [maxSteps] rounds.
  ///
  /// [context], when given, is sent as a second system message ahead of the
  /// history: resources the person attached. It is not part of the chat.
  ///
  /// [chat] gives the subject of the chat the answer is for, read at each
  /// request (a new chat only has one once its first message is saved, which
  /// the request does not wait for).
  ///
  /// With a [bridge], the tools and the system prompt are the web app's (its
  /// tool list is read at the start of each answer; [tools] are then only
  /// the ones the web app lacks, or all of them when the web app cannot be
  /// reached).
  Stream<AiEvent> run(
    List<ChatEntry> history, {
    String? context,
    List<AiTool> tools = const [],
    WebToolBridge? bridge,
    String? Function()? chat,
  }) async* {
    final clock = Stopwatch()..start();
    final recent = _recent(history);
    final builtIn = tools;
    var usedWeb = false;
    var webReady = false;
    String? webPrompt;
    final webState =
        bridge != null && _completions != null ? _prepare(bridge) : null;
    if (webState != null) {
      var web = webState.ready;
      if (web == null && webGrace > Duration.zero) {
        // Not ready: wait a moment at most (a warm page answers at once).
        web = await webState.future.timeout(webGrace, onTimeout: () => null);
      }
      if (web != null && !_hasSearch(web)) {
        // The page adds web search once its MCP server connects, which can
        // be after it was first read: read it again before going without.
        _refreshWeb(bridge!);
        final fresh =
            await webState.future.timeout(webRetryGrace, onTimeout: () => null);
        if (fresh != null) web = fresh;
      }
      if (web != null) {
        tools = _mergeTools(web, builtIn);
        webPrompt = web.prompt;
        usedWeb = true;
        webReady = true;
      }
      if (web == null || !_hasSearch(web)) {
        yield const AiNotice(webUnavailableNotice);
      }
    }
    final system = [
      {
        'role': 'system',
        'content': webPrompt ??
            (tools.isEmpty || _completions == null
                ? _systemPrompt
                : '$_systemPrompt$_toolsPrompt'),
      },
      if (context != null && context.isNotEmpty)
        {'role': 'system', 'content': context},
    ];
    final completions = _completions;
    if (completions == null) {
      final messages = <Map<String, String>>[
        for (final m in system) {'role': m['role']!, 'content': m['content']!},
        for (final e in recent) {'role': e.role, 'content': _flatText(e)},
      ];
      debugPrint('[ai] sending ${messages.length} messages '
          '(${recent.length} of ${history.length} of the chat) to model "$model"');
      yield* _stream!(messages, model).map(AiTextDelta.new);
      return;
    }
    final messages = <Map<String, dynamic>>[
      ...system,
      for (final e in recent) ..._wire(e),
    ];
    var defs = tools.isEmpty ? null : [for (final t in tools) t.definition];
    debugPrint('[ai] sending ${messages.length} messages '
        '(${recent.length} of ${history.length} of the chat, '
        '${tools.length} tools) to model "$model"');
    var calledTools = false;
    var chunks = 0;
    try {
      for (var step = 0; step < maxSteps; step++) {
        if (webState != null && !usedWeb) {
          // The page became ready meanwhile: its tools and prompt from here on.
          final web = webState.ready;
          if (web != null) {
            usedWeb = true;
            tools = _mergeTools(web, builtIn);
            defs = [for (final t in tools) t.definition];
            if (web.prompt != null) {
              messages[0] = {'role': 'system', 'content': web.prompt};
            }
          }
        }
        final text = StringBuffer();
        final calls = <_Call>[];
        debugPrint(
            '[ai-perf] step $step request sent +${clock.elapsedMilliseconds}ms '
            '(web tools ${usedWeb ? 'on' : webReady ? 'on' : 'off'})');
        await for (final chunk in _complete(messages, defs, chat?.call())) {
          if (chunks++ == 0) {
            debugPrint('[ai-perf] first chunk +${clock.elapsedMilliseconds}ms');
          }
          // The last chunk has no choices, only what the request used.
          final usage = chunk['usage'];
          final used = usage is Map ? AiUsage.fromJson(usage) : null;
          if (used != null) yield used;
          final choices = chunk['choices'];
          if (choices is! List || choices.isEmpty) continue;
          final delta = (choices.first as Map)['delta'];
          if (delta is! Map) continue;
          final content = delta['content'];
          if (content is String && content.isNotEmpty) {
            text.write(content);
            yield AiTextDelta(content);
          }
          final toolCalls = delta['tool_calls'];
          if (toolCalls is List) {
            for (final raw in toolCalls) {
              if (raw is Map) _addCallDelta(calls, raw);
            }
          }
        }
        if (calls.isEmpty) return;
        calledTools = true;
        messages.add({
          'role': 'assistant',
          'content': text.isEmpty ? null : text.toString(),
          'tool_calls': [
            for (final c in calls)
              {
                'id': c.id,
                'type': 'function',
                'function': {'name': c.name, 'arguments': c.args.toString()},
              },
          ],
        });
        for (final c in calls) {
          final raw = c.args.toString();
          final input = _decodeArgs(raw);
          final badArgs = _argsError(raw);
          final part = ToolPart(
            toolCallId: c.id,
            toolName: c.name,
            state: ToolState.inputAvailable,
            input: input,
          );
          yield AiToolStarted(part);
          String result;
          AiToolFinished finished;
          final tool = tools.where((t) => t.name == c.name).firstOrNull;
          try {
            if (tool == null) throw StateError('Unknown tool ${c.name}');
            if (badArgs != null) throw StateError(badArgs);
            final output = await tool.execute(input).timeout(toolTimeout);
            finished = AiToolFinished(part.done(output));
            result = tool.rawResult && output is String
                ? output
                : jsonEncode(output);
          } catch (e) {
            final message = e is StateError
                ? e.message
                : e is TimeoutException
                    ? 'The tool took longer than ${toolTimeout.inSeconds} '
                        'seconds and was stopped.'
                    : '$e';
            finished = AiToolFinished(part.failed(message));
            result = 'Error: $message';
          }
          yield finished;
          messages.add({
            'role': 'tool',
            'tool_call_id': c.id,
            'content': result,
          });
        }
      }
    } finally {
      debugPrint('[ai-perf] done +${clock.elapsedMilliseconds}ms '
          '($chunks chunks)');
      // Tools may have changed the drive (classes, tables): the prompt and
      // tool list are read again in the background for the next answer.
      if (calledTools && webState != null && bridge != null) {
        _refreshWeb(bridge);
      }
    }
  }

  static bool _hasSearch(_WebSetup web) =>
      web.tools.any((t) => t.name == webSearchTool);

  static List<AiTool> _mergeTools(_WebSetup web, List<AiTool> builtIn) {
    final names = {for (final t in web.tools) t.name};
    return [
      ...web.tools,
      for (final t in builtIn)
        if (!names.contains(t.name)) t,
    ];
  }

  final _webStates = Expando<_WebState>();

  /// Starts reading the web app's tools and prompt from [bridge] (booting its
  /// page) if that is not done yet, and keeps them for the life of the
  /// bridge. The chat screen calls this when it opens, so the first answer
  /// finds them ready.
  void warmWeb(WebToolBridge bridge) => _prepare(bridge);

  _WebState _prepare(WebToolBridge bridge) {
    final state = _webStates[bridge] ??= _WebState();
    if (state.loading == null && state.ready == null) {
      _load(bridge, state);
    }
    return state;
  }

  void _refreshWeb(WebToolBridge bridge) {
    final state = _webStates[bridge];
    if (state == null || state.loading != null) return;
    // The old setup keeps serving until the new one is there.
    _load(bridge, state);
  }

  void _load(WebToolBridge bridge, _WebState state) {
    final done = Completer<_WebSetup?>();
    state.loading = done.future;
    state.future = done.future;
    _webSetup(bridge).then((web) {
      if (web != null) state.ready = web;
      state.loading = null;
      done.complete(web ?? state.ready);
    });
  }

  /// The web app's tools and prompt from [bridge]; null when it cannot be
  /// reached or offers no tool (the built-in tools are then used).
  Future<_WebSetup?> _webSetup(WebToolBridge bridge) async {
    try {
      final defs = await bridge.listTools().timeout(webSetupTimeout);
      if (defs.isEmpty) return null;
      String? prompt;
      try {
        final text = await bridge.systemPrompt().timeout(webSetupTimeout);
        if (text.trim().isNotEmpty) prompt = text;
      } catch (e) {
        debugPrint('[ai] no system prompt from the web app: $e');
      }
      return _WebSetup([for (final d in defs) AiTool.web(d, bridge)], prompt);
    } catch (e) {
      debugPrint('[ai] web tools unavailable, using the built-in ones: $e');
      return null;
    }
  }

  /// A long chat is cut to its latest part: the model reads (and the
  /// account bills) every token, and an old chat made the first word slow.
  /// The newest message is always sent.
  static List<ChatEntry> _recent(List<ChatEntry> history) {
    var recent = history.length > maxHistoryMessages
        ? history.sublist(history.length - maxHistoryMessages)
        : history;
    var chars = 0;
    var start = recent.length;
    while (start > 0 && chars + _size(recent[start - 1]) <= maxHistoryChars) {
      chars += _size(recent[--start]);
    }
    return recent.sublist(start == recent.length ? start - 1 : start);
  }

  /// About how much of the model's budget an entry takes.
  static int _size(ChatEntry e) {
    var n = 0;
    for (final p in e.parts) {
      n += switch (p) {
        TextPart(:final text) => text.length,
        FilePart() => p.isImage ? 1000 : (p.text?.length ?? 100),
        ToolPart(:final input, :final output, :final errorText) =>
          jsonEncode(input).length +
              jsonEncode(output).length +
              (errorText?.length ?? 0),
        RawPart() => 0,
      };
    }
    return n;
  }

  /// A file as the model reads it: a text file's text, otherwise a note.
  static String _fileText(FilePart f) {
    final name = f.filename ?? 'file';
    final text = f.text;
    if (text != null) {
      final cut = text.length > maxFileChars
          ? '${text.substring(0, maxFileChars)}\n…(cut)'
          : text;
      return 'Attached file "$name":\n```\n$cut\n```';
    }
    return f.isImage
        ? '[The person attached an image, "$name", which you cannot see.]'
        : '[The person attached "$name" (${f.mediaType}), which you cannot '
            'read.]';
  }

  /// An entry as text only (for a stream without tools).
  static String _flatText(ChatEntry e) => [
        for (final p in e.parts)
          if (p is TextPart && p.text.trim().isNotEmpty)
            p.text
          else if (p is FilePart)
            _fileText(p),
      ].join('\n\n');

  /// An entry as model messages: a user's text and files; an assistant's
  /// text, and its tool calls with their results.
  List<Map<String, dynamic>> _wire(ChatEntry e) {
    if (e.role != 'assistant') {
      final content = <Map<String, dynamic>>[];
      for (final p in e.parts) {
        if (p is TextPart && p.text.trim().isNotEmpty) {
          content.add({'type': 'text', 'text': p.text});
        } else if (p is FilePart) {
          content.add(p.isImage && acceptsImages
              ? {
                  'type': 'image_url',
                  'image_url': {'url': p.url},
                }
              : {'type': 'text', 'text': _fileText(p)});
        }
      }
      if (content.length == 1 && content.single['type'] == 'text') {
        return [
          {'role': e.role, 'content': content.single['text']},
        ];
      }
      return [
        {'role': e.role, 'content': content},
      ];
    }
    final out = <Map<String, dynamic>>[];
    final text = StringBuffer();
    final calls = <ToolPart>[];
    void flushCalls() {
      if (calls.isEmpty) return;
      out.add({
        'role': 'assistant',
        'content': text.isEmpty ? null : text.toString(),
        'tool_calls': [
          for (final c in calls)
            {
              'id': c.toolCallId,
              'type': 'function',
              'function': {
                'name': c.toolName,
                'arguments': jsonEncode(c.input ?? const {}),
              },
            },
        ],
      });
      text.clear();
      for (final c in calls) {
        out.add({
          'role': 'tool',
          'tool_call_id': c.toolCallId,
          'content': c.state == ToolState.outputError
              ? 'Error: ${c.errorText ?? ''}'
              : c.output is String
                  ? c.output as String
                  : jsonEncode(c.output),
        });
      }
      calls.clear();
    }

    for (final p in e.parts) {
      if (p is TextPart) {
        if (calls.isNotEmpty) flushCalls();
        if (p.text.trim().isEmpty) continue;
        if (text.isNotEmpty) text.write('\n\n');
        text.write(p.text);
      } else if (p is ToolPart) {
        if (p.state.running) {
          // No result was recorded: the model is told, not given a call.
          flushCalls();
          if (text.isNotEmpty) text.write('\n\n');
          text.write('Previous tool call ${p.toolCallId} (${p.toolName}) has '
              'no recorded result. Its outcome is unknown.');
        } else {
          calls.add(p);
        }
      }
    }
    flushCalls();
    if (text.isNotEmpty) {
      out.add({'role': 'assistant', 'content': text.toString()});
    }
    return out;
  }

  /// The AI of the account whose saved session is [session] (as
  /// [shared.AtomicAccountClient.restoreSession] takes it), or null when the
  /// provider offers none. Throws when the provider cannot be reached. The
  /// host reads the session from its own storage.
  static Future<HostedAi?> forSession(String session) async {
    final origin = shared.AtomicAccountClient.sessionOrigin(session);
    final client = shared.AtomicAccountClient(origin.toString())
      ..restoreSession(session);
    final status = await client.aiStatus();
    if (status == null) {
      client.close();
      return null;
    }
    final ai = HostedAi(
      status: status,
      chatCompletions: (messages, model, tools, chat) =>
          client.chatCompletionChunks(messages,
              model: model, tools: tools, chat: chat),
      enable: client.aiConsent,
      transcribe: (wav, {language}) =>
          client.transcribe(wav, language: language),
      voiceStatus: client.voiceStatus,
      loadModels: client.aiModels,
      portal: origin,
    );
    await ai.restoreChoice();
    return ai;
  }
}

/// The web app's tools and prompt, read from its page.
class _WebSetup {
  final List<AiTool> tools;
  final String? prompt;
  _WebSetup(this.tools, this.prompt);
}

/// What was read from one bridge: [ready] once it is there; [future] is the
/// read in progress (completing with null when it failed and nothing older
/// is kept).
class _WebState {
  _WebSetup? ready;
  Future<_WebSetup?>? loading;
  Future<_WebSetup?> future = Future.value(null);
}

/// A tool call as its pieces arrive.
class _Call {
  String id;
  String name;
  final int index;
  final StringBuffer args = StringBuffer();
  _Call(this.index, this.id, this.name);
}

/// Adds a `tool_calls` delta: a new call (by its index, or a new id at an
/// index already taken), or more of an argument string.
void _addCallDelta(List<_Call> calls, Map raw) {
  final index = (raw['index'] as num?)?.toInt() ?? calls.length;
  final id = raw['id'] as String?;
  final fn = raw['function'];
  final name = fn is Map ? fn['name'] as String? : null;
  final args = fn is Map ? fn['arguments'] : null;
  var call = calls.where((c) => c.index == index).lastOrNull;
  if (call == null ||
      (id != null && id.isNotEmpty && call.id != id && call.id.isNotEmpty)) {
    call = _Call(index, id ?? 'call_${calls.length}', name ?? '');
    calls.add(call);
  }
  if (call.id.isEmpty && id != null) call.id = id;
  if (name != null && name.isNotEmpty && call.name.isEmpty) call.name = name;
  if (args is String) {
    call.args.write(args);
  } else if (args is Map) {
    call.args.write(jsonEncode(args));
  }
}

Map<String, dynamic> _decodeArgs(String raw) {
  if (raw.trim().isEmpty) return {};
  try {
    final v = jsonDecode(raw);
    return v is Map ? Map<String, dynamic>.from(v) : {'value': v};
  } catch (_) {
    return {'arguments': raw};
  }
}

/// The `error` of a tool result that is `{"error": …}` alone; null otherwise.
String? _errorOf(String text) {
  if (!text.startsWith('{') || !text.contains('"error"')) return null;
  try {
    final v = jsonDecode(text);
    if (v is Map && v.length == 1 && v['error'] != null) return '${v['error']}';
  } catch (_) {}
  return null;
}

/// Why the model's tool arguments cannot be used, or null when they can.
String? _argsError(String raw) {
  if (raw.trim().isEmpty) return null;
  try {
    if (jsonDecode(raw) is Map) return null;
    return 'The arguments of the tool call must be a JSON object.';
  } catch (e) {
    return 'The arguments of the tool call are not valid JSON; call the tool '
        'again with a valid JSON object.';
  }
}
