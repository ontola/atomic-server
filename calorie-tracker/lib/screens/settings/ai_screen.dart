import 'dart:async';

import 'package:flutter/material.dart';

import '../../services/embedding_queue.dart';
import '../../services/live_suggestions.dart';
import '../../services/meal_index.dart';
import '../../services/meal_priors.dart';
import '../../services/openrouter.dart';
import '../openrouter_screen.dart';
import 'widgets.dart';

/// The two models this app uses, in the order the user meets them: the one on
/// the network that turns a photo into calories, and the one on the phone that
/// recognises a meal it has seen before.
///
/// Both are "AI" to the person holding it, and they fail in ways that look
/// alike from the viewfinder — nothing happens — so they belong on one screen
/// even though only one of them costs money.
class AiScreen extends StatelessWidget {
  const AiScreen({
    super.key,
    this.account,
    this.index,
    this.embeddings,
    this.live,
  });

  /// Who pays for the estimates. Null in tests, and then the row that leads to
  /// them is not shown.
  final OpenRouterAccount? account;

  // ── The bring-up readout (temporary) ─────────────────────────────────────
  //
  // Phase 7 has four links — source written, meal estimated, vector encoded,
  // score over the bar — and from the viewfinder all four failures look like an
  // empty row. These make the chain legible on a phone that is not plugged into
  // anything. Take them out once the thresholds are settled (§11).

  /// The decoded vectors. Null from anywhere that has not got one, and then the
  /// section is absent.
  final MealIndex? index;

  /// Which meals still need one.
  final EmbeddingQueue? embeddings;

  /// The live matcher, when this was opened from the viewfinder — it carries
  /// the last score that was actually measured.
  final LiveSuggestions? live;

  static Future<void> open(
    BuildContext context, {
    OpenRouterAccount? account,
    MealIndex? index,
    EmbeddingQueue? embeddings,
    LiveSuggestions? live,
  }) {
    return Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => AiScreen(
        account: account,
        index: index,
        embeddings: embeddings,
        live: live,
      ),
    ));
  }

  /// What the hub says under "AI" without opening it: whether the thing that
  /// costs money is connected, which is the only state here anybody has to act
  /// on.
  static String describe(OpenRouterAccount? account) {
    if (account == null) return 'Estimates, and recognising meals';
    return account.isConnected
        ? account.model
        : 'Not connected — meals wait for their calories';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('AI')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'Photos are sent to a vision model to be counted. '
                    'Recognising a meal you have eaten before happens on this '
                    'phone, and nothing leaves it.',
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  if (account != null) ...[
                    const SizedBox(height: 20),
                    EstimatesSection(account: account!),
                  ],
                  if (index != null && embeddings != null) ...[
                    const SizedBox(height: 20),
                    RecognitionSection(
                      index: index!,
                      embeddings: embeddings!,
                      live: live,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Where the calorie numbers come from, one tap away.
///
/// A row rather than the whole screen: connecting an account and choosing a
/// model is a thing done once, and what is worth saying here is whether it has
/// been done at all.
class EstimatesSection extends StatelessWidget {
  const EstimatesSection({super.key, required this.account});

  final OpenRouterAccount account;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: AnimatedBuilder(
        animation: account,
        builder: (context, _) => SettingsTile(
          icon: Icons.receipt_long_outlined,
          title: 'Estimates',
          subtitle: account.isConnected
              ? account.model
              : 'Not connected — meals wait for their calories',
          onTap: () => OpenRouterScreen.open(context, account: account),
        ),
      ),
    );
  }
}

/// Where the suggestion pipeline has got to — **temporary, for the device
/// bring-up** (`../planning/calorie-tracker-embeddings.md` §11).
///
/// The feature is a chain of four links and the viewfinder reports all four
/// failures the same way, by showing nothing: a meal with no source file, a
/// meal never estimated, a meal never encoded, and a meal encoded but scoring
/// under the bar are one silence. This says which.
///
/// Remove it once the thresholds are settled. It is deliberately plain and
/// unlovely — nobody should want to keep it.
class RecognitionSection extends StatefulWidget {
  const RecognitionSection({
    super.key,
    required this.index,
    required this.embeddings,
    this.live,
  });

  final MealIndex index;
  final EmbeddingQueue embeddings;
  final LiveSuggestions? live;

  @override
  State<RecognitionSection> createState() => _RecognitionSectionState();
}

class _RecognitionSectionState extends State<RecognitionSection> {
  @override
  void initState() {
    super.initState();
    // Both are cheap and both are what this section is for: arriving here to
    // find a stale count would be its own red herring.
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    // Past the latch first: [DinoV2Encoder] remembers a failure for the life of
    // the process so it does not re-attempt once per meal, which also means a
    // retry button that did not do this could only ever report the same failure
    // back.
    await widget.embeddings.encoder.reset();
    await widget.embeddings.drain();
    await widget.index.refresh();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final live = widget.live;

    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Text('Recognising meals (diagnostics)',
                style: theme.textTheme.titleSmall),
          ),
          // Stacked rather than [LabeledRow]'s label-and-value line: these
          // values are sentences, and a right-aligned single line ellipsised
          // every one of them at about the point they started saying something.
          StackedRow(label: 'Index', value: widget.index.describeLastLoad()),
          StackedRow(
            label: 'Encoder',
            value: widget.embeddings.describeLastDrain(),
          ),
          // The whole point of the card. Everything above says *that* it
          // failed; this is the only thing that says why, and it is the
          // platform's own words rather than a category this app invented.
          if (widget.embeddings.encoder.lastError case final error?)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
              child: SelectableText(
                error,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                  fontFamily: 'monospace',
                ),
              ),
            ),
          if (live != null)
            StackedRow(
              label: 'Last look',
              value: live.framesEncoded == 0
                  ? 'no frames scored'
                  : '${live.framesEncoded} frames, ${live.lastEncodeMs}ms each\n'
                      'best ever ${live.bestEver.toStringAsFixed(3)}, '
                      'last ${live.bestSeen.toStringAsFixed(3)}\n'
                      'a chip needs ${LiveSuggestions.suggestThreshold}, '
                      'a prior ${MealPriors.contextThreshold}',
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
            child: Text(
              'A meal is suggestible once it has been photographed, estimated '
              'and encoded. "Last look" is what the camera scored the last '
              'time it looked at anything.',
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: _refresh,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('Encode what is missing'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
