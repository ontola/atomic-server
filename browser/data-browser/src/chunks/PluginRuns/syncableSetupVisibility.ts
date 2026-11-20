// @wc-ignore-file
import {
  canonicalizeScheme,
  core,
  findSchema,
  isAtomicIdentifier,
  pluginSchema,
  subjectsReferToSameResource,
  type Resource,
  type Store,
} from '@tomic/lib';
import { platformLocalId, syncablePlatformSchema } from './syncablePlatform';

export interface SetupVisibilityTerms {
  appClass?: string;
  properties: Record<string, string | undefined>;
  dataProperty?: string;
}

function entries(index: unknown): Array<[string, string]> {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return [];
  const values = Object.entries(index);
  if (values.length > 1000) return [];

  return values.filter(
    (entry): entry is [string, string] =>
      entry[0].startsWith('syncables:platform:') &&
      typeof entry[1] === 'string' &&
      entry[1].length > 0 &&
      entry[1].length < 65_536,
  );
}

/** Editable indexes must not make the sidebar fetch arbitrary external URLs. */
export function syncableSetupSubjects(
  index: unknown,
  server: string,
): string[] {
  return [...new Set(entries(index).map(([, subject]) => subject))].filter(
    subject => {
      if (isAtomicIdentifier(subject)) return true;

      try {
        const url = new URL(subject);

        return (
          url.origin === new URL(server).origin &&
          !url.username &&
          !url.password &&
          !url.hash
        );
      } catch {
        return false;
      }
    },
  );
}

/** Hide only coherent, explicitly marked setup Apps; never principal Apps. */
export function hiddenSyncableSetups(
  index: unknown,
  resources: ReadonlyMap<string, Pick<Resource, 'subject' | 'get'>>,
  terms: SetupVisibilityTerms,
): Set<string> {
  const hidden = new Set<string>();
  const p = terms.properties;
  const setup = p['syncable-platform-setup'];
  const marker = p['builtin-app'];
  const platform = p['syncable-platform-id'];
  const proxy = p['syncable-proxy-origin'];
  if (
    !setup ||
    !marker ||
    !platform ||
    !proxy ||
    !terms.appClass ||
    !terms.dataProperty
  )
    return hidden;

  for (const [localId, subject] of entries(index)) {
    const row = resources.get(subject);
    if (!row || row.get(setup) !== true || row.get(marker) !== 'syncables')
      continue;
    const classes = row.get(core.properties.isA);
    const platformId = row.get(platform);
    const origin = row.get(proxy);
    const binding = row.get(terms.dataProperty);
    if (
      !Array.isArray(classes) ||
      !classes.includes(terms.appClass) ||
      typeof platformId !== 'string' ||
      typeof origin !== 'string' ||
      typeof binding !== 'string' ||
      !subjectsReferToSameResource(binding, row.subject) ||
      !subjectsReferToSameResource(subject, row.subject) ||
      row.get(core.properties.localId) !== localId
    )
      continue;

    try {
      if (platformLocalId(origin, platformId) === localId)
        hidden.add(canonicalizeScheme(row.subject));
    } catch {
      // A malformed or unrelated resource is retained in ordinary navigation.
    }
  }

  return hidden;
}

export async function syncableSetupVisibilityTerms(
  store: Store,
  drive: string,
): Promise<SetupVisibilityTerms> {
  const [platform, app] = await Promise.all([
    findSchema(store, drive, syncablePlatformSchema()),
    findSchema(store, drive, pluginSchema()),
  ]);

  return {
    properties: platform.properties ?? {},
    appClass: app.classes?.app,
    dataProperty: app.properties?.['app-data'],
  };
}

/** Same stored-data policy for the AI's drive tree and the visible drive tree. */
export async function readHiddenSyncableSetups(
  store: Store,
  drive: string,
): Promise<Set<string>> {
  const terms = await syncableSetupVisibilityTerms(store, drive);
  const property = terms.properties['syncable-platform-index'];
  if (!property) return new Set();
  const root = await store.getResource(drive);
  const index = root.get(property);
  const rows = await Promise.all(
    syncableSetupSubjects(index, store.getServerUrl()).map(async subject => {
      const row = await store.getResource(subject);

      return [subject, row] as const;
    }),
  );

  return hiddenSyncableSetups(index, new Map(rows), terms);
}
