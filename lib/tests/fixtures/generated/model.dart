// Generated from atomic:frozen:5ae51fa584042c60d193f98a65897c9a07374dbcef60c06364213addaa52f53c. Do not edit.
import 'dart:convert';
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

enum SchemaType0 { value0("mono"),value1("poly") ;
 const SchemaType0(this.value); final String value;
 static SchemaType0 fromJson(Object? v) => values.firstWhere((e) => e.value == v, orElse: () => throw FormatException('Invalid enum'));
}

class SchemaType2 {
 SchemaType2.fromJson(Map<String,Object?> value):_json=(_copy(value) as Map).cast<String,Object?>() { _check("{\"type\":\"object\",\"properties\":{\"base\":{\"type\":\"number\"}},\"required\":[\"base\"],\"additionalProperties\":false}",_json); }
 final Map<String,Object?> _json;
 Map<String,Object?> toJson()=>(_copy(_json) as Map).cast<String,Object?>();
 bool get hasBase => _json.containsKey("base");
 double get baseValue {  final v=_json["base"]; return (v as num).toDouble(); }
}

class SchemaType1 {
 SchemaType1.fromJson(Object? value): _value=_copy(value) { _check("{\"type\":\"union\",\"variants\":[{\"type\":\"number\",\"minimum\":0.0},{\"type\":\"object\",\"properties\":{\"base\":{\"type\":\"number\"}},\"required\":[\"base\"],\"additionalProperties\":false}]}", _value); }
 final Object? _value;
 Object? toJson()=>_copy(_value);
 double get asVariant0 { _check("{\"type\":\"number\",\"minimum\":0.0}", _value); final v=_value; return (v as num).toDouble(); }
 SchemaType2 get asVariant1 { _check("{\"type\":\"object\",\"properties\":{\"base\":{\"type\":\"number\"}},\"required\":[\"base\"],\"additionalProperties\":false}", _value); final v=_value; return SchemaType2.fromJson((v as Map).cast<String,Object?>()); }
}

class ExampleModel {
 ExampleModel.fromJson(Map<String,Object?> value):_json=(_copy(value) as Map).cast<String,Object?>() { _check("{\"type\":\"object\",\"properties\":{\"comment\":{\"type\":\"nullable\",\"inner\":{\"type\":\"string\"}},\"midiKey\":{\"type\":\"integer\",\"minimum\":0.0,\"maximum\":127.0},\"mode\":{\"type\":\"enum\",\"values\":[\"mono\",\"poly\"]},\"name\":{\"type\":\"string\",\"maxLength\":100},\"steps\":{\"type\":\"array\",\"items\":{\"type\":\"integer\",\"minimum\":0.0,\"maximum\":127.0},\"maxItems\":128},\"toJson\":{\"type\":\"string\"},\"type\":{\"type\":\"boolean\"},\"value\":{\"type\":\"union\",\"variants\":[{\"type\":\"number\",\"minimum\":0.0},{\"type\":\"object\",\"properties\":{\"base\":{\"type\":\"number\"}},\"required\":[\"base\"],\"additionalProperties\":false}]}},\"required\":[\"mode\",\"name\",\"value\"],\"additionalProperties\":false}",_json); }
 final Map<String,Object?> _json;
 Map<String,Object?> toJson()=>(_copy(_json) as Map).cast<String,Object?>();
 bool get hasComment => _json.containsKey("comment");
 String? get comment { if (!_json.containsKey("comment")) { return null; } final v=_json["comment"]; return v == null ? null : (v as String); }
 bool get hasMidiKey => _json.containsKey("midiKey");
 int? get midiKey { if (!_json.containsKey("midiKey")) { return null; } final v=_json["midiKey"]; return (v as num).toInt(); }
 bool get hasMode => _json.containsKey("mode");
 SchemaType0 get mode {  final v=_json["mode"]; return SchemaType0.fromJson(v); }
 bool get hasName => _json.containsKey("name");
 String get name {  final v=_json["name"]; return v as String; }
 bool get hasSteps => _json.containsKey("steps");
 List<int>? get steps { if (!_json.containsKey("steps")) { return null; } final v=_json["steps"]; return List<int>.unmodifiable((v as List).map((v) => (v as num).toInt())); }
 bool get hasToJson => _json.containsKey("toJson");
 String? get toJsonValue { if (!_json.containsKey("toJson")) { return null; } final v=_json["toJson"]; return v as String; }
 bool get hasType => _json.containsKey("type");
 bool? get typeValue { if (!_json.containsKey("type")) { return null; } final v=_json["type"]; return v as bool; }
 bool get hasValue => _json.containsKey("value");
 SchemaType1 get value {  final v=_json["value"]; return SchemaType1.fromJson(v); }
}
