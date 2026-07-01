import { Resource } from './resource.js';
import { Datatype } from './datatypes.js';
import { core } from './ontologies/core.js';
import { commits } from './ontologies/commits.js';
import { server } from './ontologies/server.js';
import type { Store } from './store.js';

/**
 * Bootstrap the core Property definitions a Store needs to validate the
 * resources that common flows create — the TS mirror of the Rust
 * `populate_base_models`. `Resource.set` opportunistically fetches a property's
 * definition to validate the value; without these in the local cache that
 * fetch hits the network (the property's `atomicdata.dev` URL), which makes
 * offline/unit tests stall and depend on the public domain being up.
 *
 * Pre-seeding them means `Store.getResource` resolves from cache and never
 * fetches. Test-only helper (not reachable from the package entry point).
 */
export async function bootstrapCoreVocab(store: Store): Promise<void> {
  const props: Array<[string, Datatype, string]> = [
    [core.properties.name, Datatype.STRING, 'name'],
    [core.properties.description, Datatype.MARKDOWN, 'description'],
    [core.properties.shortname, Datatype.SLUG, 'shortname'],
    [core.properties.parent, Datatype.ATOMIC_URL, 'parent'],
    [core.properties.isA, Datatype.RESOURCEARRAY, 'is-a'],
    [core.properties.datatype, Datatype.ATOMIC_URL, 'datatype'],
    [core.properties.classtype, Datatype.ATOMIC_URL, 'classtype'],
    [core.properties.read, Datatype.RESOURCEARRAY, 'read'],
    [core.properties.write, Datatype.RESOURCEARRAY, 'write'],
    [server.properties.drives, Datatype.RESOURCEARRAY, 'drives'],
    [core.properties.personalDrive, Datatype.ATOMIC_URL, 'personal-drive'],
    [commits.properties.createdAt, Datatype.TIMESTAMP, 'created-at'],
  ];

  for (const [subject, datatype, shortname] of props) {
    const r = new Resource(subject);
    await r.set(core.properties.isA, [core.classes.property], false);
    await r.set(core.properties.datatype, datatype, false);
    await r.set(core.properties.shortname, shortname, false);
    store.addResource(r);
  }
}
