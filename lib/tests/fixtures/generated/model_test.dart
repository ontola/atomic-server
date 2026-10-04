import 'model.dart';
void main() {
 final missing=ExampleModel.fromJson({'name':'Bass','mode':'mono','value':{'base':0.5}});
 if(missing.hasComment || missing.mode!=SchemaType0.value0 || missing.value.asVariant1.baseValue!=0.5) throw StateError('Typed decode failed');
 final withNull=ExampleModel.fromJson({'name':'Bass','mode':'mono','value':1,'comment':null});
 if(!withNull.hasComment || withNull.comment!=null || !withNull.toJson().containsKey('comment')) throw StateError('Presence lost');
 for(final bad in [{'name':'Bass','mode':'bad','value':1},{'name':'Bass','mode':'mono','value':-1},{'name':'Bass','mode':'mono','value':1,'steps':[128]}]) {
  var rejected=false;
  try {ExampleModel.fromJson(bad);} on FormatException {rejected=true;}
  if(!rejected) throw StateError('Invalid model accepted');
 }
 final named=ExampleModel.fromJson({'name':'Bass','mode':'mono','value':1,'midiKey':60,'type':true,'toJson':'label'});
 if(named.midiKey!=60 || named.typeValue!=true || named.toJsonValue!='label' || named.toJson()['midiKey']!=60) throw StateError('Accessor names changed wire keys');
 print('Generated Dart model checks passed');
}
