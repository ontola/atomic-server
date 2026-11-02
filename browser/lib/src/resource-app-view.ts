import { dataBrowser } from './ontologies/dataBrowser.js';
import { core } from './ontologies/core.js';
import { findSchema, type SchemaStore } from './plugin-schema.js';
import { pluginSchema } from './plugin-log.js';

/** A renderer binding is a reference to an installed App, never executable source or a grant. */
export async function resolveResourceAppView(
  store: SchemaStore,
  drive: string,
  subject: string,
): Promise<string | undefined> {
  const schema = await findSchema(store, drive, pluginSchema());
  if (!schema.classes?.app || !schema.properties?.entrypoint) return undefined;
  const app = await store.getResource(subject);
  const classes = app.get(core.properties.isA);
  if (!Array.isArray(classes) || !classes.includes(schema.classes.app))
    return undefined;
  if (typeof app.get(schema.properties.entrypoint) !== 'string')
    return undefined;

  // Discovery stays drive-scoped after metadata is moved under the ontology.
  const seen = new Set<string>();
  let ancestor: string | undefined = subject;

  for (let depth = 0; ancestor && depth < 16; depth++) {
    if (ancestor === drive) return subject;
    if (seen.has(ancestor)) return undefined;
    seen.add(ancestor);
    const resource = await store.getResource(ancestor);
    const parent = resource.get(core.properties.parent);
    ancestor = typeof parent === 'string' ? parent : undefined;
  }

  return undefined;
}

/** An unambiguous installed renderer with no dataset can render existing content. */
export async function resolveDefaultResourceAppView(
  store: SchemaStore,
  drive: string,
  subject: string,
  apps: Array<{ subject: string; resourceRenders?: string[] }>,
): Promise<string | undefined> {
  const resource = await store.getResource(subject);
  const classes = resource.get(core.properties.isA);
  if (!Array.isArray(classes)) return undefined;
  // A table keeps its explicit view tabs and their grants.
  if (classes.includes(dataBrowser.classes.table)) return undefined;
  const types = [...classes];
  const rowClass = resource.get(core.properties.classtype);
  if (
    classes.includes(dataBrowser.classes.folder) &&
    typeof rowClass === 'string'
  )
    types.push(rowClass);
  const schema = await findSchema(store, drive, pluginSchema());
  const dataProperty = schema.properties?.['app-data'];
  if (!dataProperty) return undefined;
  const compatible: string[] = [];

  for (const app of apps) {
    if (!app.resourceRenders?.some(type => types.includes(type))) continue;
    const installation = await store.getResource(app.subject);
    if (installation.get(dataProperty)) continue;
    if (await resolveResourceAppView(store, drive, app.subject))
      compatible.push(app.subject);
  }

  return compatible.length === 1 ? compatible[0] : undefined;
}
