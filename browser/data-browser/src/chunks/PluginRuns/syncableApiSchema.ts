// @wc-ignore-file
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  Datatype,
  ensureSchema,
  findSchema,
  type EnsuredSchema,
  type SchemaSpec,
  type SchemaStore,
  type JSONValue,
  core,
} from '@tomic/lib';
import {
  deriveOntology,
  ontologyShortname,
  prepareDocument,
} from 'syncables/browser';
import { platformLocalId } from './syncablePlatform';

export interface SyncableApiSchema {
  classes: Record<string, string>;
  properties: Record<string, string>;
  /** A field name can be a link for one resource and ordinary JSON for another. */
  resourceProperties?: Record<string, Record<string, string>>;
  requiredProperties?: Record<string, string[]>;
  /** Raw nonnullable API requirements, including optional derived link bindings. */
  requiredFields?: Record<string, string[]>;
}

/** Presentation changes never change a provider's Atomic vocabulary identities. */
export function syncableApiSchemaSpec(
  proxyOrigin: string,
  platform: string,
  document: Record<string, unknown>,
): {
  spec: SchemaSpec;
  classKeys: Record<string, string>;
  propertyKeys: Record<string, string>;
  resourcePropertyKeys: Record<string, Record<string, string>>;
  requiredPropertyKeys: Record<string, string[]>;
  requiredFieldNames: Record<string, string[]>;
} {
  platformLocalId(proxyOrigin, platform);
  const scope = bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify([proxyOrigin, platform]))),
  ).slice(0, 24);
  const prepared = prepareDocument(document);
  const ontology = deriveOntology(prepared);
  if (ontology.terms.length > 1024)
    throw new Error('The integration schema has too many terms');
  const propertyKeys: Record<string, string> = {};
  const classKeys: Record<string, string> = {};
  const properties: SchemaSpec['properties'] = [];
  const classes: SchemaSpec['classes'] = [];
  const termProperties = new Map<string, string>();
  const resourcePropertyKeys: Record<string, Record<string, string>> = {};
  const requiredPropertyKeys: Record<string, string[]> = {};
  const requiredFieldNames: Record<string, string[]> = {};
  const resources = Object.keys(prepared.components?.crudResources ?? {});
  const resourceNames = new Map(
    resources.map(name => [ontologyShortname(name), name]),
  );

  for (const term of ontology.terms) {
    if (!term.shortname || term.shortname.length > 160)
      throw new Error('The integration schema has an invalid term name');
    if (term.kind !== 'property') continue;
    if (!Object.values(Datatype).includes(term.datatype as Datatype))
      throw new Error('The integration schema has an unsupported datatype');
    // Atomic Properties are immutable. A type change gets a new Property,
    // retaining the previous property and its saved values for compatibility.
    const datatype = term.datatype.slice(term.datatype.lastIndexOf('/') + 1);
    const key = `api-${scope}-${term.shortname}-${datatype}`;
    propertyKeys[term.shortname] = key;
    termProperties.set(term.path, key);
    properties.push({
      shortname: key,
      name: term.shortname,
      description: term.description,
      datatype: term.datatype as Datatype,
    });
  }

  for (const term of ontology.terms) {
    if (term.kind !== 'class') continue;
    const key = `api-${scope}-${term.shortname}`;
    classKeys[term.shortname] = key;
    const resource = resourceNames.get(term.shortname);
    if (!resource) throw new Error('The integration class has no resource');
    const propertiesOf = (paths: string[]) =>
      paths.map(path => {
        const property = termProperties.get(path);
        if (!property)
          throw new Error(
            'The integration schema refers to an unknown property',
          );

        return property;
      });
    const requires = propertiesOf(term.requires);
    requiredPropertyKeys[resource] = requires;
    resourcePropertyKeys[resource] = propertyKeys;
    requiredFieldNames[resource] = term.requires.map(path =>
      path.slice(path.lastIndexOf('/') + 1),
    );
    classes.push({
      shortname: key,
      name: term.shortname,
      description: term.description,
      requires,
      recommends: propertiesOf(term.recommends),
    });
  }

  return {
    spec: { properties, classes },
    classKeys,
    propertyKeys,
    resourcePropertyKeys,
    requiredPropertyKeys,
    requiredFieldNames,
  };
}

/** Schema installation is a native setup action, outside every iframe grant. */
export async function syncableApiSchema(
  store: SchemaStore,
  drive: string,
  proxyOrigin: string,
  platform: string,
  document: Record<string, unknown>,
  initialize: boolean,
  assertCurrent: () => void = () => {},
): Promise<SyncableApiSchema> {
  const {
    spec,
    classKeys,
    propertyKeys,
    resourcePropertyKeys,
    requiredPropertyKeys,
    requiredFieldNames,
  } = syncableApiSchemaSpec(proxyOrigin, platform, document);
  const managedProperties = new Set<string>();
  const managedClasses = new Set<string>();
  const wrap = (resource: Awaited<ReturnType<SchemaStore['getResource']>>) => ({
    get subject() {
      return resource.subject;
    },
    get: resource.get.bind(resource),
    getPropVals: resource.getPropVals?.bind(resource),
    set: async (property: string, value: JSONValue) => {
      assertCurrent();

      if (
        managedClasses.has(resource.subject) &&
        (property === core.properties.requires ||
          property === core.properties.recommends) &&
        Array.isArray(value)
      ) {
        const previous = resource.get(property);
        const custom = Array.isArray(previous)
          ? previous.filter(
              subject =>
                typeof subject === 'string' && !managedProperties.has(subject),
            )
          : [];
        value = [...new Set([...value, ...custom])];
      }

      // Resource.set rechecks this callback after awaited Property validation,
      // immediately before changing the live Loro document.
      const guarded = resource as typeof resource & {
        set(
          property: string,
          value: JSONValue,
          validate: boolean,
          datatype: undefined,
          guard: () => void,
        ): Promise<void>;
      };
      await guarded.set(property, value, true, undefined, assertCurrent);
      assertCurrent();
    },
    save: async () => {
      assertCurrent();
      const result = await resource.save();
      assertCurrent();

      return result;
    },
    ...(resource.pushListItem
      ? {
          pushListItem: (property: string, value: JSONValue) => {
            assertCurrent();
            resource.pushListItem!(property, value);
          },
        }
      : {}),
  });
  const guardedStore: SchemaStore = {
    getResource: async subject => {
      assertCurrent();
      const resource = await store.getResource(subject);
      assertCurrent();

      return wrap(resource);
    },
    findByLocalId: async (...args) => {
      assertCurrent();
      const resource = await store.findByLocalId(...args);
      assertCurrent();

      return resource ? wrap(resource) : undefined;
    },
    newResource: async options => {
      assertCurrent();
      const resource = await store.newResource(options);
      assertCurrent();

      return wrap(resource);
    },
  };
  assertCurrent();

  if (initialize) {
    const existing = await findSchema(guardedStore, drive, spec);
    assertCurrent();
    Object.values(existing.properties ?? {}).forEach(subject =>
      managedProperties.add(subject),
    );
    Object.values(existing.classes ?? {}).forEach(subject =>
      managedClasses.add(subject),
    );
  }

  const resolved: Partial<EnsuredSchema> = initialize
    ? await ensureSchema(guardedStore, drive, spec)
    : await findSchema(guardedStore, drive, spec);
  assertCurrent();
  const pick = (
    keys: Record<string, string>,
    terms: Record<string, string> | undefined,
  ) =>
    Object.fromEntries(
      Object.entries(keys).map(([name, key]) => {
        const subject = terms?.[key];
        if (!subject)
          throw new Error(
            'Open the integration once to install its catalog schema',
          );

        return [name, subject];
      }),
    );

  return {
    classes: pick(classKeys, resolved.classes),
    properties: pick(propertyKeys, resolved.properties),
    resourceProperties: Object.fromEntries(
      Object.entries(resourcePropertyKeys).map(([resource, keys]) => [
        resource,
        pick(keys, resolved.properties),
      ]),
    ),
    requiredProperties: Object.fromEntries(
      Object.entries(requiredPropertyKeys).map(([resource, keys]) => [
        resource,
        keys.map(key => {
          const subject = resolved.properties?.[key];
          if (!subject)
            throw new Error('The required integration property is unavailable');

          return subject;
        }),
      ]),
    ),
    requiredFields: requiredFieldNames,
  };
}
