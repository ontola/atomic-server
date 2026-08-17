/**
 * Moved into `@tomic/lib` so the Store can bound its own migration fetches
 * (see `Store.fetchLegacyAgentResource`). Re-exported here so existing
 * imports keep working.
 */
export { withDeadline } from '@tomic/lib';
