import 'package:calorie_tracker/main.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

/// The encoder's licence, and that it reaches the page that shows it.
///
/// This app redistributes 89 MB of Apache 2.0 weights inside a binary, so
/// section 4's conditions — a copy of the licence, the attribution, a statement
/// of what was changed — are this app's to meet. Everything in that chain is a
/// string: two asset paths, a `pubspec.yaml` entry, and a registration call in
/// `main`. Break any of them and nothing fails at build time, nothing fails at
/// runtime, and the licence page is simply missing an entry that nobody looks
/// at often enough to notice.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the encoder licence is registered and carries what it must', () async {
    registerBundledLicenses();

    final entries = <LicenseEntry>[];
    await for (final entry in LicenseRegistry.licenses) {
      entries.add(entry);
    }

    final dinov2 = entries.where(
      (e) => e.packages.any((p) => p.contains('dinov2')),
    );
    expect(dinov2, isNotEmpty,
        reason: 'the weights are bundled, so the licence has to ship with them');

    final text = dinov2
        .expand((e) => e.paragraphs)
        .map((p) => p.text)
        .join('\n');

    expect(text, contains('Apache License'),
        reason: 'section 4(a): recipients get a copy of the licence');
    expect(text, contains('Meta Platforms'),
        reason: 'section 4(d): the attribution notices are retained');
    expect(text, contains('CHANGES MADE TO THE WORK'),
        reason: 'section 4(b): modified work carries notice of the changes');

    // The two changes named, because "we changed it" is not the statement the
    // licence asks for — and because these are the claims tool/export_model.py
    // verifies on every run.
    expect(text, contains('[1, 384]'));
    expect(text, contains('[1, 3, 224, 224]'));
  });
}
