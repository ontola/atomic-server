Object? _copy(Object? value) => jsonDecode(jsonEncode(value));
void _check(String encoded, Object? value) {
  var budget = 100000;
  void check(Map<String, dynamic> s, Object? v, int depth) {
    if (--budget < 0 || depth > 32) {
      throw const FormatException('Shape budget exceeded');
    }
    Never bad() => throw const FormatException('Value does not match schema');
    num? number() => v is num && v.isFinite ? v : null;
    switch (s['type']) {
      case 'string':
        if (v is! String ||
            (s['maxLength'] != null && v.runes.length > s['maxLength'])) {
          bad();
        }
      case 'reference':
        if (v is! String ||
            !RegExp(r'^(atomic:(?!//)|did:ad:|https?://)').hasMatch(v) ||
            Uri.tryParse(v) == null) {
          bad();
        }
      case 'number':
      case 'integer':
        final n = number();
        if (n == null ||
            (s['type'] == 'integer' &&
                (n != n.roundToDouble() || n.abs() > 9007199254740991)) ||
            (s['minimum'] != null && n < s['minimum']) ||
            (s['maximum'] != null && n > s['maximum'])) {
          bad();
        }
      case 'boolean':
        if (v is! bool) {
          bad();
        }
      case 'null':
        if (v != null) {
          bad();
        }
      case 'enum':
        if (!(s['values'] as List).contains(v)) {
          bad();
        }
      case 'nullable':
        if (v != null) {
          check(s['inner'], v, depth + 1);
        }
      case 'union':
        var matched = false;
        for (final variant in s['variants']) {
          try {
            check(variant, v, depth + 1);
            matched = true;
            break;
          } on FormatException {
            if (budget < 0) {
              rethrow;
            }
          }
        }
        if (!matched) {
          bad();
        }
      case 'array':
        if (v is! List || (s['maxItems'] != null && v.length > s['maxItems'])) {
          bad();
        }
        for (final item in v) {
          check(s['items'], item, depth + 1);
        }
      case 'object':
        if (v is! Map) {
          bad();
        }
        final map = v;
        final properties = s['properties'] as Map;
        for (final key in s['required'] ?? []) {
          if (!map.containsKey(key)) {
            bad();
          }
        }
        for (final key in map.keys) {
          if (properties.containsKey(key)) {
            check(properties[key], map[key], depth + 1);
          } else if (s['additionalProperties'] != true) {
            bad();
          }
        }
      default:
        bad();
    }
  }

  check((jsonDecode(encoded) as Map).cast<String, dynamic>(), value, 0);
}
