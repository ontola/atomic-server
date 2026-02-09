import '../src/rust/api/simple.dart' as ffi;
import 'atomic_client.dart';

AgentInfo createAgent(String name) {
  final a = ffi.createAgent(name: name);
  return AgentInfo(
      secret: a.secret,
      subject: a.subject,
      publicKey: a.publicKey,
      name: a.name);
}

AgentInfo agentFromSecret(String secret) {
  final a = ffi.agentFromSecret(secret: secret);
  return AgentInfo(
      secret: a.secret,
      subject: a.subject,
      publicKey: a.publicKey,
      name: a.name);
}

Future<String> connect(String serverUrl, String agentSecret) =>
    ffi.connect(serverUrl: serverUrl, agentSecret: agentSecret);

Future<String> createDrive(String name) => ffi.createDrive(name: name);

void setDrive(String subject) => ffi.setActiveDrive(subject: subject);

String? getDrive() => ffi.getActiveDrive();

Future<String> createCanvas(String name) => ffi.createCanvas(name: name);

Future<String> loadCanvasStrokes(String subject) =>
    ffi.loadCanvasStrokes(subject: subject);

Future<List<CanvasListItem>> listCanvases() async {
  final items = await ffi.listCanvases();
  return items
      .map((i) => CanvasListItem(subject: i.subject, name: i.name))
      .toList();
}

Future<void> deleteCanvas(String subject) => ffi.deleteCanvas(subject: subject);

Future<void> renameCanvas(String subject, String name) =>
    ffi.renameCanvas(subject: subject, name: name);
