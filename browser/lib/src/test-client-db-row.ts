import { Resource } from './resource.js';
import { commits } from './ontologies/commits.js';

/**
 * The JSON-AD row a local database holds for a resource written as Loro bytes
 * (`ClientDbWorker.putLoroSnapshot`): what the WASM side derives from the doc,
 * for test doubles that serve rows back to a reader.
 */
export function rowFromLoroSnapshot(
  subject: string,
  snapshot: Uint8Array,
  lastCommit?: string,
): string {
  const resource = new Resource(subject);
  resource.applyHydratedValues([[commits.properties.loroUpdate, snapshot]]);
  const obj = resource.toObject({ includeBinary: false }) ?? { '@id': subject };

  if (lastCommit) obj[commits.properties.lastCommit] = lastCommit;

  return JSON.stringify(obj);
}
