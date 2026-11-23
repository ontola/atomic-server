// @wc-ignore-file
/** Native projection of direct references observed by the host reader. No frame entry point. */
import {
  core,
  dataBrowser,
  Datatype,
  readConnectionSubjects,
  subjectsReferToSameResource,
  type JSONValue,
  type Resource,
  type Store,
} from '@tomic/lib';
import {
  describeEntityTypes,
  describeResourceFields,
  ontologyShortname,
  resolveEntityIdentity,
  resolveResourceField,
  relatedCollectionReads,
  parseReadSelection,
  type EntityObservation,
  type OpenApiDocument,
  type ResourceFieldDescription,
  type ResolvedResourceFieldObject,
  type TypedReadContext,
} from 'syncables/browser';
import {
  entitySourceKey,
  entityTableKey,
  sourceConfigFingerprint,
  sourceKey,
  type SyncablePrincipal,
} from './builtinSyncIdentity.js';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
} from './syncableSource';
import {
  assertSyncableLocalSubject,
  assertSyncableResourceActive,
  classifySyncableResourceDrive,
  queueSyncableProvisioning,
} from './syncablePlatform';
import { isSyncablePrincipalApp } from './syncablePrincipalApp';
import {
  validateSyncableReferenceEvidence,
  type SyncableReferenceEvidence,
} from './builtinSyncReferenceIdentity.js';

export type { SyncableReferenceEvidence } from './builtinSyncReferenceIdentity.js';

export interface ReferenceMaterializationContext {
  drive: string;
  proxyOrigin: string;
  platform: string;
  principal: SyncablePrincipal;
  principalApp: string;
  /** Host-proved active filter origins stay immutable for this projection. */
  readonlyOriginEntityKeys?: readonly string[];
  document: OpenApiDocument;
  schema: {
    classes: Record<string, string>;
    properties: Record<string, string>;
  };
  apiSchema: {
    classes: Record<string, string>;
    properties: Record<string, string>;
    resourceProperties?: Record<string, Record<string, string>>;
    requiredProperties?: Record<string, string[]>;
    requiredFields?: Record<string, string[]>;
  };
}
export interface MaterializedReferenceField {
  sourceEntityKey: string;
  field: string;
  property: string;
  cardinality: 'one' | 'many';
  present: boolean;
  resolved: boolean;
  subjects: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  subjectsReferToSameResource(a, b);
const equal = (a: unknown, b: unknown) =>
  sourceConfigFingerprint(a) === sourceConfigFingerprint(b);
const localId = (key: string) => 'syncables:node:' + encodeURIComponent(key);
const copy = <T>(value: T): T => structuredClone(value);

export { validateSyncableReferenceEvidence } from './builtinSyncReferenceIdentity.js';

/** Fill missing supplied information; explicit null, arrays and existing values remain evidence. */
function fillAbsent(
  previous: Record<string, unknown>,
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(supplied)])].map(
      key => {
        const old = previous[key],
          next = supplied[key];

        return [
          key,
          !Object.hasOwn(previous, key)
            ? copy(next)
            : object(old) && object(next)
              ? fillAbsent(old, next)
              : copy(old),
        ];
      },
    ),
  );
}

function evidenceFor(
  context: ReferenceMaterializationContext,
  observation: EntityObservation,
  descriptor: ResourceFieldDescription,
  index: number,
): SyncableReferenceEvidence {
  const resources = context.document.components?.crudResources as
    | Record<string, unknown>
    | undefined;
  const source = resources?.[descriptor.sourceResource] as
    | Record<string, unknown>
    | undefined;
  const identity = source?.identity as
    | { bindings?: Record<string, { field: string }> }
    | undefined;
  const references = source?.['references'] as
    | Record<string, { bindings?: Record<string, { field: string }> }>
    | undefined;
  const fields = [
    descriptor.field,
    ...Object.values(identity?.bindings ?? {}).map(binding => binding.field),
    ...Object.values(
      references?.[descriptor.reference ?? '']?.bindings ?? {},
    ).map(binding => binding.field),
  ];
  const sourceRecord: Record<string, unknown> = {};

  for (const field of fields) {
    const names = field.split('.');
    let input: unknown = observation.raw;
    let target = sourceRecord;

    for (let part = 0; part < names.length; part++) {
      const name = names[part];
      if (!object(input) || !Object.hasOwn(input, name)) break;
      input = input[name];

      if (part === names.length - 1)
        Object.defineProperty(target, name, {
          value: copy(input),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else {
        if (!object(target[name]))
          Object.defineProperty(target, name, {
            value: {},
            enumerable: true,
            configurable: true,
            writable: true,
          });
        target = target[name] as Record<string, unknown>;
      }
    }
  }

  return {
    version: 1,
    sourceResource: descriptor.sourceResource,
    sourceEntity: copy(observation.entity),
    sourceRecord,
    context: copy(observation.context),
    field: descriptor.field,
    index,
  };
}

/** Call only with observations returned by a host-owned compiled reader's response journal. */
export async function materializeSyncableReferences(
  store: Store,
  context: ReferenceMaterializationContext,
  observations: readonly EntityObservation[],
  assertCurrent: () => void,
): Promise<MaterializedReferenceField[]> {
  assertCurrent();
  if (observations.length > 10_000)
    throw new Error('The reference observation budget was exceeded');
  // Validate the complete batch before any allocation. Never use projected frame values.
  const plans = observations.flatMap(observation => {
    const identity = resolveEntityIdentity(context.document, {
      resource: observation.entity.resource,
      record: observation.raw,
      context: observation.context,
    });
    if (
      !equal(identity, observation.entity) ||
      observation.provenance.read.resource !== identity.resource
    )
      throw new Error(
        'The native observation does not match its actual record identity',
      );

    return describeResourceFields(context.document, identity.resource).map(
      descriptor => ({
        observation,
        descriptor,
        resolution: resolveResourceField(
          context.document,
          descriptor,
          observation.raw,
          observation.context,
        ),
      }),
    );
  });
  if (
    plans.reduce((sum, plan) => sum + plan.resolution.objects.length, 0) >
    10_000
  )
    throw new Error('The reference target budget was exceeded');

  if (!plans.some(plan => plan.resolution.objects.length))
    return plans.map(({ observation, descriptor, resolution }) => ({
      sourceEntityKey: observation.entity.key,
      field: descriptor.field,
      property: descriptor.property,
      cardinality: descriptor.cardinality,
      present: resolution.present,
      resolved: resolution.status === 'resolved',
      subjects: [],
    }));

  return queueSyncableProvisioning(store, context.drive, async () => {
    const actor = store.getAgent()?.subject,
      server = store.getServerUrl();
    const scope = () => [
      context.drive,
      context.proxyOrigin,
      context.platform,
      context.principal,
      context.principalApp,
      context.readonlyOriginEntityKeys,
    ];
    const scopeStamp = sourceConfigFingerprint(scope());
    const readonlyOrigins = new Set(context.readonlyOriginEntityKeys ?? []);
    const document = context.document;
    const schema = context.schema;
    const apiSchema = context.apiSchema;
    const watched = new Map<
      Resource,
      { fields: string[]; stamp: string; fieldStamps: Map<string, string> }
    >();
    const identityFields = [
      ...new Set([
        context.schema.properties['syncable-source-key'],
        context.schema.properties['syncable-source-config'],
        context.schema.properties['syncable-node-kind'],
        context.schema.properties['syncable-entity-table'],
        context.schema.properties['syncable-reference-evidence'],
        context.schema.properties['syncable-navigation-intents'],
        core.properties.parent,
        core.properties.isA,
        core.properties.localId,
        core.properties.classtype,
        core.properties.name,
        core.properties.read,
        core.properties.write,
        dataBrowser.properties.tableViews,
        dataBrowser.properties.tableDefaultView,
        'https://atomicdata.dev/properties/drive',
        dataBrowser.properties.trashFolder,
      ]),
    ];
    const stamp = (
      row: Resource,
      fields = watched.get(row)?.fields ?? identityFields,
    ) => sourceConfigFingerprint(fields.map(field => row.get(field)));

    const watch = (row: Resource, fields: string[] = []) => {
      const selected = [
        ...new Set([
          ...(watched.get(row)?.fields ?? identityFields),
          ...fields,
        ]),
      ];
      watched.set(row, {
        fields: selected,
        stamp: stamp(row, selected),
        fieldStamps: new Map(
          selected.map(field => [
            field,
            sourceConfigFingerprint(row.get(field)),
          ]),
        ),
      });
    };

    const guard = (except?: Resource) => {
      assertCurrent();
      if (
        !actor ||
        store.getAgent()?.subject !== actor ||
        store.getServerUrl() !== server ||
        sourceConfigFingerprint(scope()) !== scopeStamp ||
        context.document !== document ||
        context.schema !== schema ||
        context.apiSchema !== apiSchema
      )
        throw new Error(
          'The active reference source, account or Drive changed',
        );

      for (const [row, expected] of watched)
        if (row !== except && stamp(row, expected.fields) !== expected.stamp) {
          const field = expected.fields.find(
            property =>
              sourceConfigFingerprint(row.get(property)) !==
              expected.fieldStamps.get(property),
          );
          throw new Error(
            `A reference identity, value, permission or ancestor changed (${row.subject}; ${field ?? 'unknown property'})`,
          );
        }
    };

    const load = async (subject: string) => {
      guard();
      assertSyncableLocalSubject(store, subject);
      const row = await store.getResource(subject);
      guard();
      if (row.error) throw row.error;
      if (!watched.has(row)) watch(row);

      return row;
    };

    const active = async (subject: string) => {
      guard();
      await assertSyncableResourceActive(store, context.drive, subject);
      guard();
      let current = subject;
      const seen = new Set<string>();

      while (
        !same(current, context.drive) &&
        !seen.has(current) &&
        seen.size < 64
      ) {
        seen.add(current);
        const row = await load(current);
        const parent = row.get(core.properties.parent);
        if (typeof parent !== 'string')
          throw new Error('The reference ancestry is incomplete');
        current = parent;
      }

      await load(context.drive);
      guard();
    };

    const writable = async (row: Resource) => {
      await active(row.subject);
      const [allowed] = await row.canWrite(actor!);
      guard();
      if (!allowed)
        throw new Error('Write access to the linked record is required');
    };

    const set = async (row: Resource, property: string, value: unknown) => {
      if (equal(row.get(property), value)) return;
      await writable(row);
      watch(row, [property]);
      const expected = sourceConfigFingerprint(
        watched
          .get(row)!
          .fields.map(field => (field === property ? value : row.get(field))),
      );
      await row.set(property, value as JSONValue, true, undefined, () =>
        guard(),
      );
      guard(row);
      if (stamp(row) !== expected)
        throw new Error('The linked record changed during its update');
      const previousWatch = watched.get(row)!;
      watched.set(row, {
        fields: previousWatch.fields,
        stamp: expected,
        fieldStamps: new Map([
          ...previousWatch.fieldStamps,
          [property, sourceConfigFingerprint(value)],
        ]),
      });
      guard();
    };

    const save = async (row: Resource) => {
      await writable(row);
      guard();
      await row.save();
      guard();
    };

    const p = context.schema.properties;
    const required = [
      'syncable-source-key',
      'syncable-source-config',
      'syncable-node-kind',
      'syncable-entity-table',
      'syncable-collection-view',
      'syncable-reference-evidence',
      'syncable-navigation-intents',
    ];
    if (
      required.some(name => !p[name]) ||
      !context.schema.classes['syncable-reference']
    )
      throw new Error('The linked record schema is unavailable');
    const app = await load(context.principalApp);
    await active(app.subject);
    const appConfig = parseSyncableSourceConfig(
      app.get(p['syncable-source-config']),
    );
    const appKey = sourceKey({ ...context, kind: 'principal' });
    if (
      app.get(p['syncable-source-key']) !== appKey ||
      appConfig.version !== 2 ||
      !equal(appConfig.principal, context.principal) ||
      !(await isSyncablePrincipalApp(store, context.drive, app))
    )
      throw new Error(
        'The linked record destination is not this principal App',
      );
    guard();
    const types = describeEntityTypes(context.document);

    const lookup = async (key: string) => {
      const found = new Set<string>();

      for (const [property, value] of [
        [p['syncable-source-key'], key],
        [core.properties.localId, localId(key)],
      ]) {
        const subjects = await readConnectionSubjects(
          store,
          context.drive,
          property,
          value,
          { includeTrashed: true },
        );
        guard();

        for (const subject of subjects) {
          if (
            !(await classifySyncableResourceDrive(
              store,
              context.drive,
              subject,
            ))
          ) {
            guard();
            continue;
          }

          await active(subject);
          found.add(store.normalizeSubject(subject));
        }
      }

      if (found.size > 1)
        throw new Error('The linked record identity is ambiguous');

      return found.size ? load([...found][0]) : undefined;
    };

    const verify = (
      row: Resource,
      key: string,
      kind: 'collection' | 'record',
    ) => {
      const raw = row.get(p['syncable-source-key']);
      const config = parseSyncableSourceConfig(
        row.get(p['syncable-source-config']),
      );
      const parsed = parseSyncableSourceKey(raw);
      if (
        raw !== key ||
        config.version !== 3 ||
        parsed.version !== 3 ||
        config.kind !== kind ||
        !sourceConfigMatchesKey(config, parsed, key) ||
        row.get(p['syncable-node-kind']) !== kind ||
        typeof row.get(core.properties.localId) !== 'string'
      )
        throw new Error('The retained linked identity cannot be validated');

      return config;
    };

    let historicalChecked = false;
    const targetResources = new Set(
      plans.flatMap(plan =>
        plan.resolution.objects.map(target => target.resource),
      ),
    );

    const rejectHistoricalTargets = async () => {
      if (historicalChecked) return;
      const subjects = await readConnectionSubjects(
        store,
        context.drive,
        p['syncable-source-key'],
        undefined,
        { includeTrashed: true },
      );
      guard();

      for (const subject of subjects) {
        assertSyncableLocalSubject(store, subject);
        const candidate = await store.getResource(subject);
        guard();
        if (candidate.error) throw candidate.error;
        let key: ReturnType<typeof parseSyncableSourceKey>;

        try {
          key = parseSyncableSourceKey(candidate.get(p['syncable-source-key']));
        } catch {
          continue;
        }

        if (
          key.proxyOrigin !== context.proxyOrigin ||
          key.platform !== context.platform ||
          key.version === 3
        )
          continue;
        if (
          key.version === 2 &&
          (!equal(key.principal, context.principal) ||
            !targetResources.has(String(key.collection?.resource)))
        )
          continue;

        if (
          !(await classifySyncableResourceDrive(store, context.drive, subject))
        ) {
          guard();
          continue;
        }

        await active(subject);
        throw new Error(
          'Retained historical linked identities require migration review before allocation',
        );
      }

      historicalChecked = true;
    };

    const create = async (
      parent: Resource,
      values: Record<string, unknown>,
    ) => {
      await rejectHistoricalTargets();
      await writable(parent);
      const row = await store.newResource({
        parent: parent.subject,
        deferGenesis: true,
      });
      guard();
      // commit.rs grants a new non-Agent DID its genesis signer's write right.
      // Author that exact outcome before publication: the ACK and its later WS
      // update may arrive separately while this row is still an ancestor guard.
      const initialValues = { ...values, [core.properties.write]: [actor!] };
      watch(row, Object.keys(initialValues));
      for (const [property, value] of Object.entries(initialValues))
        await set(row, property, value);
      await save(row);

      return row;
    };

    const tables = new Map<string, Resource>();

    const tableFor = async (resource: string, requireExisting = false) => {
      if (tables.has(resource)) return tables.get(resource)!;
      const type = types.find(item => item.resource === resource);
      const rowClass = context.apiSchema.classes[ontologyShortname(resource)];
      if (!type || !rowClass)
        throw new Error('The linked entity type is not declared');
      const key = entityTableKey({ ...context, resource });
      let table = await lookup(key);

      if (table) {
        verify(table, key, 'collection');
        if (
          !table.hasClasses(dataBrowser.classes.table) ||
          !same(table.get(core.properties.classtype), rowClass)
        )
          throw new Error(
            'The retained linked table has a different API class',
          );
      } else {
        if (requireExisting)
          throw new Error('The active Sync filter origin table is unavailable');
        const bindings = {
          ...context.apiSchema.properties,
          ...context.apiSchema.resourceProperties?.[resource],
        };
        const columns = type.presentation.columns
          .flatMap(column =>
            bindings[column.property]
              ? [
                  {
                    property: bindings[column.property],
                    label: column.label,
                    ...(column.labels
                      ? { format: 'enum', labels: column.labels }
                      : {}),
                  },
                ]
              : [],
          )
          .slice(0, 40);
        table = await create(app, {
          [core.properties.name]: type.presentation.title,
          [core.properties.localId]: localId(key),
          [p['syncable-source-key']]: key,
          [p['syncable-node-kind']]: 'collection',
          [p['syncable-source-config']]: {
            version: 3,
            kind: 'collection',
            proxyOrigin: context.proxyOrigin,
            platform: context.platform,
            principal: context.principal,
            resource,
            ...(context.principal.kind === 'authenticated' &&
            appConfig.connectionId
              ? { connectionId: appConfig.connectionId }
              : {}),
          },
          [core.properties.classtype]: rowClass,
          [p['syncable-collection-view']]: {
            version: 1,
            rowClass,
            title: type.presentation.title,
            columns: columns.length
              ? columns
              : [{ property: core.properties.name, label: 'Name' }],
            ...(type.relationships.length
              ? { relationships: type.relationships }
              : {}),
          },
          [core.properties.isA]: [dataBrowser.classes.table],
        });
        const views: string[] = [];

        for (const [name, kind] of [
          ['Collection', 'syncable-collection'],
          ['Table', 'table'],
          ['Sync', 'syncables'],
        ]) {
          const view = await create(table, {
            [core.properties.name]: name,
            [dataBrowser.properties.viewKind]: kind,
            [core.properties.isA]: [dataBrowser.classes.view],
          });
          views.push(view.subject);
          watched.delete(view);
        }

        await set(table, dataBrowser.properties.tableViews, views);
        await set(table, dataBrowser.properties.tableDefaultView, views[0]);
        await save(table);
      }

      tables.set(resource, table);

      return table;
    };

    const targets = new Map<string, Resource>();

    const upsert = async (
      target: ResolvedResourceFieldObject,
      evidence: SyncableReferenceEvidence,
      typedContext: TypedReadContext,
    ) => {
      const key = entitySourceKey({
        ...context,
        entityIdentity: target.entity,
      });
      const readonlyOrigin = readonlyOrigins.has(target.entity.key);
      const retainedOrigin = readonlyOrigin
        ? (targets.get(key) ?? (await lookup(key)))
        : undefined;
      if (readonlyOrigin && !retainedOrigin)
        throw new Error('The active Sync filter origin is unavailable');
      const table = await tableFor(target.resource, readonlyOrigin);
      let row = retainedOrigin ?? targets.get(key) ?? (await lookup(key));
      let previous: ReturnType<typeof parseSyncableSourceConfig> | undefined;

      if (row) {
        await active(row.subject);
        watch(row);
        previous = verify(row, key, 'record');
        if (
          !same(row.get(p['syncable-entity-table']), table.subject) ||
          !equal(previous.entityIdentity, target.entity)
        )
          throw new Error(
            'The retained linked row has a different canonical table or identity',
          );
        let proved = false;

        try {
          proved = equal(
            resolveEntityIdentity(context.document, {
              resource: target.resource,
              record: previous.record!,
              context: previous.context,
            }),
            target.entity,
          );
        } catch {
          /* A scalar reference has no fabricated raw object. */
        }

        if (
          !proved &&
          (!row.hasClasses(context.schema.classes['syncable-reference']) ||
            !validateSyncableReferenceEvidence(
              context.document,
              row.get(p['syncable-reference-evidence']),
              target.entity,
            ))
        )
          throw new Error(
            'The retained linked row has no valid identity evidence',
          );

        if (readonlyOrigin) {
          if (!proved)
            throw new Error('The active Sync filter origin identity changed');
          // Reading a child may return its owner with extra fields or request
          // context. Do not rewrite the source proof of this in-flight read.
          targets.set(key, row);
          watched.delete(row);

          return row;
        }

        if (!same(row.get(core.properties.parent), table.subject)) {
          targets.set(key, row);
          watched.delete(row);

          return row;
        }
      }

      const bindings = {
        ...context.apiSchema.properties,
        ...context.apiSchema.resourceProperties?.[target.resource],
      };
      const links = new Set(
        describeResourceFields(context.document, target.resource).map(
          field => field.property,
        ),
      );
      const supplied: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(target.fields))
        if (
          !links.has(name) &&
          bindings[name] &&
          field.kind === 'value' &&
          (!row || row.get(bindings[name]) === undefined)
        )
          supplied[bindings[name]] = field.value;
      if (row) watch(row, Object.keys(supplied));
      const raw = fillAbsent(previous?.record ?? {}, target.object ?? {});
      const savedContext: TypedReadContext = {
        ...typedContext,
        ...previous?.context,
      };
      const managed = [
        ...new Set([
          ...(previous?.managedProperties ?? []),
          ...Object.keys(supplied),
        ]),
      ];
      const config = {
        ...(previous ?? {}),
        version: 3,
        kind: 'record',
        proxyOrigin: context.proxyOrigin,
        platform: context.platform,
        principal: context.principal,
        resource: target.resource,
        entityIdentity: target.entity,
        record: raw,
        context: savedContext,
        managedProperties: managed,
      };
      // Native observation proves the canonical object, but not membership in
      // this entity's own collection. Keep that read absent unless it existed.
      let intents: unknown[] = [];
      let canonical = false;

      try {
        canonical = equal(
          resolveEntityIdentity(context.document, {
            resource: target.resource,
            record: raw,
            context: savedContext,
          }),
          target.entity,
        );
      } catch {
        /* Scalar references need not contain a navigable raw object. */
      }

      try {
        if (canonical) {
          const relationships =
            types.find(type => type.resource === target.resource)
              ?.relationships ?? [];
          intents = relatedCollectionReads(context.document, {
            resource: target.resource,
            record: raw,
            context: Object.fromEntries(
              Object.entries(savedContext).map(([name, value]) => [
                name,
                String(value),
              ]),
            ),
          })
            .flatMap(navigation => {
              const via = {
                collection: navigation.collection,
                kind:
                  navigation.kind === 'direct' ? 'identity' : 'responseLink',
                ...('reference' in navigation
                  ? { reference: navigation.reference }
                  : {}),
                ...('link' in navigation ? { link: navigation.link } : {}),
              };
              const relationship = relationships.find(
                candidate =>
                  candidate.resource === navigation.resource &&
                  equal(candidate.via, via),
              );
              if (!relationship) return [];

              return [
                {
                  version: 1,
                  sourceEntityKey: key,
                  resource: navigation.resource,
                  label: relationship.title,
                  definition: parseReadSelection({
                    version: 1,
                    resource: navigation.resource,
                    source: {
                      kind: 'related',
                      origin: {
                        entity: target.entity,
                        record: raw,
                        context: savedContext,
                        ...(previous?.read ? { read: previous.read } : {}),
                      },
                      via,
                    },
                  }),
                },
              ];
            })
            .slice(0, 100);
        }
      } catch {
        // A valid embedded identity can omit a separate relationship binding.
        // Preserve its stored data without inventing a navigable origin.
        intents = [];
      }

      const fullClass =
        context.apiSchema.classes[ontologyShortname(target.resource)];
      const requiredProperties =
        context.apiSchema.requiredProperties?.[target.resource];
      const actualClass = await load(fullClass);
      watch(actualClass, [core.properties.requires]);
      const actualRequired = actualClass.get(core.properties.requires);
      if (
        !Array.isArray(actualRequired) ||
        actualRequired.some(property => typeof property !== 'string')
      )
        throw new Error('The target API class has invalid required properties');
      if (row) watch(row, actualRequired);
      const complete =
        !!target.object &&
        !!requiredProperties &&
        (context.apiSchema.requiredFields?.[target.resource] ?? []).every(
          field => target.fields[field]?.kind === 'value',
        ) &&
        requiredProperties.every(property => {
          const name = Object.keys(bindings).find(
            fieldName => bindings[fieldName] === property,
          );
          const value = Object.hasOwn(supplied, property)
            ? supplied[property]
            : row?.get(property);

          return (
            name !== undefined &&
            target.fields[name]?.kind === 'value' &&
            value !== null &&
            value !== undefined
          );
        }) &&
        actualRequired.every(property => {
          const value = Object.hasOwn(supplied, property)
            ? supplied[property]
            : row?.get(property);

          return value !== null && value !== undefined;
        });
      const classes = [
        ...new Set([
          ...(row?.getSubjects(core.properties.isA) ?? []),
          context.schema.classes['syncable-reference'],
          ...(complete ? [fullClass] : []),
        ]),
      ];
      const labels =
        types
          .find(type => type.resource === target.resource)
          ?.presentation.columns.flatMap(column => {
            const field = target.fields[column.property];

            return field?.kind === 'value' &&
              typeof field.value === 'string' &&
              field.value.trim()
              ? [{ column, value: field.value }]
              : [];
          }) ?? [];
      const name =
        labels.find(
          ({ column, value }) =>
            column.datatype === Datatype.STRING &&
            !/^(?:uri|iri|url)(?:-reference)?$/i.test(column.format ?? '') &&
            !/^(?:[a-z][a-z0-9+.-]*:\S|\/\/)/i.test(value.trim()),
        )?.value ??
        labels[0]?.value ??
        target.entity.path;
      const values = {
        ...supplied,
        [p['syncable-source-config']]: config,
        [p['syncable-navigation-intents']]: intents,
        ...(target.object
          ? {}
          : { [p['syncable-reference-evidence']]: evidence }),
        [core.properties.isA]: classes,
      };

      if (!row)
        row = await create(table, {
          [core.properties.name]: name,
          [core.properties.localId]: localId(key),
          [p['syncable-source-key']]: key,
          [p['syncable-node-kind']]: 'record',
          [p['syncable-entity-table']]: table.subject,
          ...values,
        });
      else {
        for (const [property, value] of Object.entries(values))
          await set(row, property, value);
        await save(row);
      }

      targets.set(key, row);
      watched.delete(row);

      return row;
    };

    const result: MaterializedReferenceField[] = [];

    for (const plan of plans) {
      const { resolution, observation, descriptor } = plan;
      const subjects: string[] = [];

      if (resolution.status === 'resolved')
        for (let index = 0; index < resolution.objects.length; index++) {
          const target = resolution.objects[index];
          const evidence = evidenceFor(context, observation, descriptor, index);
          if (
            !target.object &&
            !validateSyncableReferenceEvidence(
              context.document,
              evidence,
              target.entity,
            )
          )
            throw new Error(
              'The scalar reference cannot retain its declared identity proof',
            );
          subjects.push(
            (await upsert(target, evidence, observation.context)).subject,
          );
        }

      result.push({
        sourceEntityKey: observation.entity.key,
        field: descriptor.field,
        property: descriptor.property,
        cardinality: descriptor.cardinality,
        present: resolution.present,
        resolved: resolution.status === 'resolved',
        subjects,
      });
    }

    guard();

    return result;
  });
}
