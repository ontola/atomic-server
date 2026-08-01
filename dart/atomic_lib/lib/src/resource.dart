import 'dart:typed_data';

class Resource {
  final String subject;
  final Map<String, dynamic> _values;

  Resource({required this.subject, Map<String, dynamic>? values})
      : _values = values ?? {};

  T? get<T>(String property) {
    final val = _values[property];
    if (val == null) return null;
    return val as T;
  }

  String? getString(String property) => get<String>(property);
  int? getInt(String property) => get<int>(property);
  bool? getBool(String property) => get<bool>(property);
  List<String>? getList(String property) {
    final val = _values[property];
    if (val is List) return val.cast<String>();
    return null;
  }

  Uint8List? getBytes(String property) {
    final val = _values[property];
    if (val is Uint8List) return val;
    return null;
  }

  Map<String, dynamic> toJson() => {
        '@id': subject,
        ..._values,
      };

  factory Resource.fromJson(Map<String, dynamic> json) {
    final subject = json['@id'] as String;
    final values = Map<String, dynamic>.from(json)..remove('@id');
    return Resource(subject: subject, values: values);
  }
}
