/**
 * Lens endpoint keys in an App's `renders` (the split-pieces exploration,
 * ontola/atomic-server#2069).
 *
 * The shared lens catalog (ontola/atomic-plugins `ontology-kit/LENSES.md`,
 * "Endpoints") names a lens endpoint that is not an Atomic class by a key:
 *
 * - `record:<openapi folder or provider>#<resource>`, a provider record as
 *   syncables reads it, e.g. `record:APIs/todoist.com/1#task`;
 * - `rdf:<RDF class IRI>`, a node of that class in expanded JSON-LD.
 *
 * An integration declares such a key in `renders` so that a catalog lens can
 * bring it to a table of a shared class. These keys are not subjects, so
 * `renders` (a ResourceArray) refuses them unless this is switched on, which
 * the data-browser does only while the split-pieces flag is on.
 *
 * **Provisional.** The keys are `endpointKey()`'s, and must agree with
 * whatever the produced-class declaration gives a derived class
 * (atomic-plugins #409, `x-produces`; pieces.md I1, O8). Until that exists,
 * do not rely on them outside the exploration.
 *
 * The server stores any string in a ResourceArray and never reads `renders`
 * entries as subjects, so it accepts these keys as they are.
 */

const RECORD_KEY = /^record:[^\s#]+#[^\s#]+$/;
const RDF_KEY = /^rdf:[a-z][a-z0-9+.-]*:[^\s]+$/i;

/** Whether `value` is a `record:` or `rdf:` lens endpoint key. */
export function isLensEndpointKey(value: unknown): value is string {
  return (
    typeof value === 'string' && (RECORD_KEY.test(value) || RDF_KEY.test(value))
  );
}

/** The shortname of the App property whose entries may be endpoint keys. */
export const RENDERS_SHORTNAME = 'renders';

let allowed: () => boolean = () => false;

/**
 * Lets `renders` hold lens endpoint keys while `enabled()` is true. The
 * data-browser passes its split-pieces flag. Off by default.
 */
export function allowLensEndpointKeysInRenders(enabled: () => boolean): void {
  allowed = enabled;
}

/** Whether `renders` may hold lens endpoint keys right now. */
export function lensEndpointKeysAllowedInRenders(): boolean {
  try {
    return allowed();
  } catch {
    return false;
  }
}
