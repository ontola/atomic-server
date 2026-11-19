import { useEffect, useState } from 'react';
import {
  core,
  dataBrowser,
  findSchema,
  subjectsReferToSameResource,
  useArray,
  useResourceSnapshot,
  useStore,
  type Resource,
} from '@tomic/react';
import { ruleSourceKey } from './builtinSyncIdentity.js';
import { ShowRoute } from '../../routes/ShowRoute';
import { getTableDrive } from '../TablePage/tableDrive';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
  type SyncableSourceConfigV3,
} from './syncableSource';
import {
  parseSyncableRuleConfig,
  type SyncableRuleConfig,
} from './syncableRules';

export interface SavedSyncableFilter {
  resource: Resource;
  config: SyncableRuleConfig;
}
interface FilterState {
  table: string;
  properties: Record<string, string>;
  source?: SyncableSourceConfigV3;
  rules: SavedSyncableFilter[];
  error?: string;
}

/** Reads Atomic configuration only. Opening a filter never contacts a provider. */
export function useSyncableFilters(table: Resource, embedded = false) {
  const store = useStore();
  const [views] = useArray(table, dataBrowser.properties.tableViews);
  const search = ShowRoute.useSearch();
  const selectedViewSnapshot = useResourceSnapshot(search.view);
  const selectedView = selectedViewSnapshot.resource;
  const [state, setState] = useState<FilterState>();
  const viewStamp = JSON.stringify(views);

  useEffect(() => {
    let active = true;
    let subscriptions: (() => void)[] = [];
    let revision = 0;
    const savedViews = JSON.parse(viewStamp) as string[];

    const refresh = async () => {
      revision = revision + 1;
      const current = revision;

      const drive = getTableDrive(store, table) ?? store.getDrive();
      if (!drive) return;
      const schema = await findSchema(store, drive, syncableHierarchySchema());
      const properties = schema.properties ?? {};
      const sourceConfigProperty = properties['syncable-source-config'];
      const raw = sourceConfigProperty
        ? table.get(sourceConfigProperty)
        : undefined;
      let source: SyncableSourceConfigV3 | undefined;

      if (
        raw &&
        typeof raw === 'object' &&
        (raw as { version?: number }).version === 3
      ) {
        const parsed = parseSyncableSourceConfig(raw);

        if (parsed.version === 3 && parsed.kind === 'collection') {
          const rawKey = table.get(properties['syncable-source-key']);
          const key = parseSyncableSourceKey(rawKey);
          if (
            key.version !== 3 ||
            !sourceConfigMatchesKey(parsed, key, String(rawKey))
          )
            throw new Error(
              'This entity collection has an invalid source identity',
            );
          source = parsed;
        }
      }

      const rules: SavedSyncableFilter[] = [];

      if (source) {
        for (const subject of savedViews) {
          const resource = await store.getResource(subject);
          const config = resource.get(properties['syncable-source-config']);
          if (
            !config ||
            typeof config !== 'object' ||
            (config as { kind?: string }).kind !== 'rule'
          )
            continue;
          if (
            resource.error ||
            !resource.hasClasses(dataBrowser.classes.view) ||
            !subjectsReferToSameResource(
              resource.get(core.properties.parent),
              table.subject,
            )
          )
            continue;

          try {
            const parsed = parseSyncableRuleConfig(config);
            const key = ruleSourceKey(
              String(table.get(properties['syncable-source-key'])),
              parsed.ruleKey,
            );
            if (
              parsed.resource === source.resource &&
              resource.get(properties['syncable-source-key']) === key &&
              resource.get(core.properties.localId) ===
                'syncables:node:' + encodeURIComponent(key)
            )
              rules.push({ resource, config: parsed });
          } catch {
            /* Invalid saved rules grant no selection or sync authority. */
          }
        }
      }

      if (!active || revision !== current) return;
      subscriptions.forEach(unsubscribe => unsubscribe());
      subscriptions = [table.subject, ...(source ? savedViews : [])].map(
        subject =>
          store.subscribe(subject, () => {
            void refresh().catch(failed);
          }),
      );
      setState({ table: table.subject, properties, source, rules });
    };

    const failed = (error: unknown) => {
      if (active)
        setState({
          table: table.subject,
          properties: {},
          rules: [],
          error: String(error),
        });
    };

    void refresh().catch(failed);

    return () => {
      active = false;
      subscriptions.forEach(unsubscribe => unsubscribe());
    };
  }, [store, table, table.subject, viewStamp]);

  const current = state?.table === table.subject ? state : undefined;
  const explicit = embedded ? undefined : search.syncFilter;
  const ruleFromView = embedded
    ? undefined
    : current?.rules.find(rule => rule.resource.subject === search.view);
  const configProperty = current?.properties['syncable-source-config'];
  const viewConfig = configProperty
    ? selectedView.get(configProperty)
    : undefined;
  const implicitRule =
    !embedded &&
    (isRuleLocalId(selectedView.get(core.properties.localId)) ||
      (viewConfig &&
        typeof viewConfig === 'object' &&
        (viewConfig as { kind?: string }).kind === 'rule'));
  const requested =
    explicit ??
    ruleFromView?.resource.subject ??
    (implicitRule ? search.view : undefined);
  // A View reached through openResource is still loading; never briefly show all rows.
  const pendingView = !embedded && !!search.view && !selectedViewSnapshot.ready;
  const selected = current?.rules.find(
    rule => rule.resource.subject === requested,
  );
  const invalid =
    !!current?.source &&
    ((!!requested && !selected) ||
      (!embedded && !!search.view && !views.includes(search.view)));

  return {
    ...current,
    rules: current?.rules ?? [],
    selected,
    requested,
    ready: !!current && !pendingView && !invalid && !current.error,
    error:
      current?.error ??
      (invalid
        ? 'This saved filter is unavailable or no longer belongs to this collection.'
        : undefined),
    flat: !!current?.source,
  };
}

function isRuleLocalId(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('syncables:node:'))
    return false;

  try {
    const key = JSON.parse(
      decodeURIComponent(value.slice('syncables:node:'.length)),
    );

    return key?.version === 3 && key?.kind === 'rule';
  } catch {
    return false;
  }
}
