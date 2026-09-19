import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import type { Datatype } from './datatypes.js';
import type { JSONValue } from './value.js';

/**
 * Creates a plugin's classes and properties as ordinary Atomic resources in the
 * drive's ontology, from a spec written in code.
 *
 * Code-first rather than baked into the core ontology: the shape of a plugin
 * run will keep moving while triggers, preview and cron are built, and churn in
 * the core ontology is paid for by every server. These live in the drive that
 * uses them, and can graduate later once the shape settles.
 */

export interface PropertySpec {
  /** Reuse this vocabulary term without editing or copying it. */
  subject?: string;
  /** Stable within the spec; also the resource's shortname. */
  shortname: string;
  name: string;
  description: string;
  datatype: Datatype;
  classtype?: string;
}

export interface ClassSpec {
  /** Reuse this class without editing or copying it. */
  subject?: string;
  shortname: string;
  name: string;
  description: string;
  /** Shortnames of properties in the same spec. */
  requires?: string[];
  recommends?: string[];
}

export interface SchemaSpec {
  properties: PropertySpec[];
  classes: ClassSpec[];
}

export interface EnsuredSchema {
  /** Shortname to subject. */
  properties: Record<string, string>;
  classes: Record<string, string>;
}

interface SchemaResource {
  subject: string;
  get(property: string): unknown;
  set(property: string, value: JSONValue): Promise<void>;
  save(): Promise<unknown>;
  pushListItem?(property: string, value: JSONValue): void;
}

export interface SchemaStore {
  /** Authoritative lookup must include saved terms not yet linked to the ontology. */
  findByLocalId(
    drive: string,
    parent: string,
    localId: string,
  ): Promise<SchemaResource | undefined>;
  getResource(subject: string): Promise<SchemaResource>;
  newResource(opts: {
    parent: string;
    isA: string[];
    propVals: Record<string, JSONValue>;
  }): Promise<SchemaResource>;
}

/**
 * Makes a spec real in a drive, reusing anything already there.
 *
 * Idempotent by shortname: a second call finds what the first created rather
 * than making a parallel set, which matters because a plugin's first run and
 * its hundredth take the same path.
 *
 * Native localIds recover saved terms even when the ontology-link write was
 * interrupted. Concurrent duplicate creates on one server reuse its winner;
 * ambiguous shortnames are errors, never arbitrary bindings.
 */
export async function ensureSchema(
  store: SchemaStore,
  drive: string,
  spec: SchemaSpec,
): Promise<EnsuredSchema> {
  const ontologySubject = await findOntology(store, drive);
  const ontology = await store.getResource(ontologySubject);

  const properties = await ensureAll(
    store,
    ontology,
    drive,
    core.properties.properties,
    spec.properties,
    property => ({
      isA: [core.classes.property],
      propVals: {
        [core.properties.shortname]: property.shortname,
        [core.properties.name]: property.name,
        [core.properties.description]: property.description,
        [core.properties.datatype]: property.datatype,
        ...(property.classtype
          ? { [core.properties.classtype]: property.classtype }
          : {}),
      },
    }),
  );

  const classes = await ensureAll(
    store,
    ontology,
    drive,
    core.properties.classes,
    spec.classes,
    klass => ({
      isA: [core.classes.class],
      propVals: {
        [core.properties.shortname]: klass.shortname,
        [core.properties.name]: klass.name,
        [core.properties.description]: klass.description,
        [core.properties.requires]: (klass.requires ?? []).map(
          name => properties[name],
        ),
        [core.properties.recommends]: (klass.recommends ?? []).map(
          name => properties[name],
        ),
      },
    }),
  );

  return { properties, classes };
}

/**
 * Looks a spec up without creating anything.
 *
 * Menus and other read paths need to know whether a drive has plugin classes;
 * they must not bring them into existence as a side effect of being rendered.
 * Returns only what is actually there.
 */
export async function findSchema(
  store: SchemaStore,
  drive: string,
  spec: SchemaSpec,
): Promise<Partial<EnsuredSchema>> {
  const driveResource = await store.getResource(drive);
  const ontologySubject = driveResource.get(server.properties.defaultOntology);

  if (typeof ontologySubject !== 'string' || ontologySubject.length === 0) {
    return {};
  }

  const ontology = await store.getResource(ontologySubject);

  const [properties, classes] = await Promise.all([
    pick(
      store,
      asList(ontology.get(core.properties.properties)),
      spec.properties,
    ),
    pick(store, asList(ontology.get(core.properties.classes)), spec.classes),
  ]);

  return { properties, classes };
}

async function pick(
  store: SchemaStore,
  subjects: string[],
  specs: Array<{ shortname: string; subject?: string }>,
): Promise<Record<string, string>> {
  const found = await byShortname(
    store,
    subjects,
    new Set(specs.map(spec => spec.shortname)),
  );

  return Object.fromEntries(
    specs
      .map(
        spec =>
          [spec.shortname, spec.subject ?? found.get(spec.shortname)] as const,
      )
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Brings an existing class or property back in line with the spec.
 *
 * Without this a drive keeps whatever shape the schema had the day it was
 * first used, and a fix to the spec never reaches anyone who already ran the
 * old one — which is the worst case, because their data is the data that
 * already exists.
 *
 * Only `requires` and `recommends` are reconciled. Names and descriptions are
 * left alone: someone may have edited them, and overwriting a person's words
 * on every boot is not a migration.
 */
async function reconcile(
  store: SchemaStore,
  subject: string,
  desired: Record<string, JSONValue>,
): Promise<void> {
  const resource = await store.getResource(subject);
  let changed = false;

  for (const property of [
    core.properties.requires,
    core.properties.recommends,
  ]) {
    const wanted = desired[property];

    if (!Array.isArray(wanted)) continue;

    const current = resource.get(property);
    const same =
      Array.isArray(current) &&
      current.length === wanted.length &&
      wanted.every(value => current.includes(value));

    if (same) continue;

    await resource.set(property, wanted);
    changed = true;
  }

  if (changed) await resource.save();
}

/** The native identity a schema term is saved under, so an interrupted
 * ontology-link write can still be recovered by its own id. */
function localIdFor(listProperty: string, shortname: string): string {
  return `schema:${listProperty === core.properties.properties ? 'property' : 'class'}:${shortname}`;
}

async function ensureAll<T extends { shortname: string; subject?: string }>(
  store: SchemaStore,
  ontology: SchemaResource,
  drive: string,
  listProperty: string,
  specs: T[],
  build: (spec: T) => { isA: string[]; propVals: Record<string, JSONValue> },
): Promise<Record<string, string>> {
  const existing = asList(ontology.get(listProperty));
  const found = await byShortname(
    store,
    existing,
    new Set(specs.map(spec => spec.shortname)),
  );
  const result: Record<string, string> = {};
  const added: string[] = [];

  // Recovering an orphan is one server round-trip per term, and on a drive
  // that has no schema yet every term takes it. Awaited inside the loop below
  // that was ~19 sequential queries of ~700ms — 13 of the 14 seconds it took
  // to create an app, before anything was written. The lookups are
  // independent reads of different localIds, so make them together and let
  // the loop consume the answers; creation stays ordered.
  const orphans = new Map<string, SchemaResource | undefined>();
  await Promise.all(
    specs
      .filter(spec => !spec.subject && !found.has(spec.shortname))
      .map(async spec => {
        orphans.set(
          spec.shortname,
          await store.findByLocalId(
            drive,
            ontology.subject,
            localIdFor(listProperty, spec.shortname),
          ),
        );
      }),
  );

  // Resolving is separated from creating so the creates can go out together.
  // Each term is a save of its own, and on a drive with no schema every term
  // needs one: 19 saves in a row, which is most of the wait between asking for
  // a plugin and seeing its page. They write different resources under the
  // same ontology and none reads another's subject, so the order they land in
  // does not matter. `slots` keeps the ontology's list in `specs` order all
  // the same, because that order is what someone reading the ontology sees.
  const slots: Array<string | undefined> = specs.map(() => undefined);
  const toCreate: Array<{ index: number; spec: T; localId: string }> = [];

  for (const [index, spec] of specs.entries()) {
    if (spec.subject) {
      const shared = await store.getResource(spec.subject);
      const desired = build(spec);
      const classes = asList(shared.get(core.properties.isA));

      if (!desired.isA.every(klass => classes.includes(klass))) {
        throw new Error(`incompatible schema binding: ${spec.subject}`);
      }

      const datatype = desired.propVals[core.properties.datatype];

      if (datatype && shared.get(core.properties.datatype) !== datatype) {
        throw new Error(`incompatible property datatype: ${spec.subject}`);
      }

      slots[index] = spec.subject;
      continue;
    }

    const localId = localIdFor(listProperty, spec.shortname);
    const hit =
      found.get(spec.shortname) ?? orphans.get(spec.shortname)?.subject;

    if (hit) {
      const resource = await store.getResource(hit);
      const desired = build(spec);
      const datatype = desired.propVals[core.properties.datatype];
      if (datatype && resource.get(core.properties.datatype) !== datatype)
        throw new Error(
          `incompatible recovered schema datatype: ${spec.shortname}`,
        );
      await reconcile(store, hit, desired.propVals);
      slots[index] = hit;
      continue;
    }

    toCreate.push({ index, spec, localId });
  }

  const created = await Promise.all(
    toCreate.map(async ({ spec, localId }) => {
      const { isA, propVals } = build(spec);
      const resource = await store.newResource({
        parent: ontology.subject,
        isA,
        propVals: { ...propVals, [core.properties.localId]: localId },
      });

      try {
        await resource.save();

        return resource.subject;
      } catch (error) {
        const recovered = await store.findByLocalId(
          drive,
          ontology.subject,
          localId,
        );
        if (!recovered) throw error;

        return recovered.subject;
      }
    }),
  );

  for (const [slot, { index }] of toCreate.entries())
    slots[index] = created[slot];

  for (const [index, spec] of specs.entries()) {
    const subject = slots[index]!;
    result[spec.shortname] = subject;
    if (!existing.includes(subject) && !added.includes(subject))
      added.push(subject);
  }

  if (added.length > 0) {
    const current = asList(ontology.get(listProperty));
    const missing = [...new Set(added)].filter(
      subject => !current.includes(subject),
    );

    if (ontology.pushListItem) {
      for (const subject of missing)
        ontology.pushListItem(listProperty, subject);
    } else {
      await ontology.set(listProperty, [...current, ...missing]);
    }

    await ontology.save();
  }

  return result;
}

/**
 * Resolves shortnames to subjects among an ontology's existing properties or
 * classes.
 *
 * `interesting` scopes ambiguity checking to the shortnames the caller
 * actually asked about. A drive's ontology accumulates entries from every
 * table and plugin that ever ran on it, so two unrelated columns landing on
 * the same shortname (two different "Status" select columns, say) is real but
 * none of this call's business — it must not fail a lookup for a shortname it
 * was never asked about.
 */
async function byShortname(
  store: SchemaStore,
  subjects: string[],
  interesting: Set<string>,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    subjects.map(async subject => {
      const resource = await store.getResource(subject);
      const shortname = resource.get(core.properties.shortname);

      return [typeof shortname === 'string' ? shortname : '', subject] as const;
    }),
  );

  const result = new Map<string, string>();

  for (const [shortname, subject] of entries) {
    if (!shortname || !interesting.has(shortname)) continue;
    if (result.has(shortname) && result.get(shortname) !== subject)
      throw new Error(`ambiguous schema shortname: ${shortname}`);
    result.set(shortname, subject);
  }

  return result;
}

async function findOntology(
  store: SchemaStore,
  drive: string,
): Promise<string> {
  const resource = await store.getResource(drive);
  const ontology = resource.get(server.properties.defaultOntology);

  if (typeof ontology !== 'string' || ontology.length === 0) {
    throw new Error(
      `drive ${drive} has no default ontology, so there is nowhere to put plugin classes`,
    );
  }

  return ontology;
}

function asList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}
