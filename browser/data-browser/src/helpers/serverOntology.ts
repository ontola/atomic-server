/**
 * Property URLs of the `Server` class, served by a node's `/server` endpoint.
 *
 * Handwritten rather than generated: these describe the *node* rather than
 * anything in a drive, so they are read from a plain `fetch` of a possibly
 * foreign server (see `fetchManagedInfo`) instead of through a store with a
 * generated ontology. Keep in sync with `lib/src/urls.rs` and
 * `lib/defaults/default_store.json`.
 */
export const serverProps = {
  nodeId: 'https://atomicdata.dev/properties/server/nodeId',
  version: 'https://atomicdata.dev/properties/server/version',
  managed: 'https://atomicdata.dev/properties/server/managed',
  portalUrl: 'https://atomicdata.dev/properties/server/portalUrl',
} as const;

export const NODE_DID_PREFIX = 'did:ad:node:';

/** True for a well-formed `did:ad:node:<64 hex>` node identity. */
export function isValidNodeDid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(NODE_DID_PREFIX) &&
    /^[0-9a-f]{64}$/i.test(value.slice(NODE_DID_PREFIX.length))
  );
}
