import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../tool/gen_terms.dart';

String _squash(String s) => s.replaceAll(RegExp(r'\s+'), '');

void main() {
  final dir = Directory(defaultDir);
  test(
    'terms.g.dart is what tool/gen_terms.dart writes from the ontology',
    () => expect(
      _squash(File('lib/src/terms.g.dart').readAsStringSync()),
      _squash(generate(dir)),
    ),
    skip:
        dir.existsSync() ? false : 'no atomic-plugins checkout at $defaultDir',
  );
}
