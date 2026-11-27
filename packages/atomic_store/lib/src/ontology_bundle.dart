import 'backend.dart';
import 'store.dart';

/// [Store.installOntology]: an app carries its ontology.
extension InstallOntology on Store {
  /// Store the app's ontology bundle in the local store, so its classes and
  /// properties resolve at once and offline.
  ///
  /// A class or property address (`https://atomicdata.dev/shop/v1/class/order`)
  /// is a name, not a place: a node that does not know it fetches it once and
  /// keeps it. This stores the bundle's resources, the Ontology and its Classes
  /// and Properties, under exactly those subjects as if they had been fetched.
  /// It makes no network request, writes no commit and syncs nothing, so the
  /// terms are the same in every drive.
  ///
  /// [bundleJson] is the JSON-AD array of the bundle (the app ships it as an
  /// asset). Call it when the app starts: it is idempotent, and a repeated call
  /// writes nothing.
  ///
  /// Throws [StoreException] ([StoreErrorKind.invalid]) and writes nothing when
  /// the bundle is not an ontology bundle, or when a term is already stored
  /// with a different datatype, shortname, `requires` and so on: an address
  /// keeps its meaning. Only `name` and `description` may change.
  Future<OntologyInstall> installOntology(String bundleJson) =>
      backend.installOntology(bundleJson);
}
