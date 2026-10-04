import 'model.dart';
void main() {
 final missing=ExampleModel.fromJson({'name':'Bass','mode':'mono','value':{'base':0.5}});
 if(missing.has_comment || missing.field_mode!=SchemaType0.value0 || missing.field_value.asVariant1.field_base!=0.5) throw StateError('Typed decode failed');
 final withNull=ExampleModel.fromJson({'name':'Bass','mode':'mono','value':1,'comment':null});
 if(!withNull.has_comment || withNull.field_comment!=null || !withNull.toJson().containsKey('comment')) throw StateError('Presence lost');
 for(final bad in [{'name':'Bass','mode':'bad','value':1},{'name':'Bass','mode':'mono','value':-1},{'name':'Bass','mode':'mono','value':1,'steps':[128]}]) {
  var rejected=false;
  try {ExampleModel.fromJson(bad);} on FormatException {rejected=true;}
  if(!rejected) throw StateError('Invalid model accepted');
 }
 print('Generated Dart model checks passed');
}
