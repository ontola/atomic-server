// @wc-ignore-file
import { Datatype, type SchemaSpec } from '@tomic/lib';

/** Preferences live on the user's private drive, with properties in its ontology. */
export function integrationVisibilitySchema(): SchemaSpec {
  return {
    properties: [
      {
        shortname: 'show-api-plugins',
        name: 'Show API plugins',
        description:
          'Offer API plugins in integration discovery. Defaults to false.',
        datatype: Datatype.BOOLEAN,
      },
      {
        shortname: 'show-experimental-plugins',
        name: 'Show experimental plugins',
        description:
          'Offer experimental bundled and community plugins in integration discovery. Defaults to false.',
        datatype: Datatype.BOOLEAN,
      },
    ],
    classes: [],
  };
}

export type IntegrationVisibilityKey =
  | 'show-api-plugins'
  | 'show-experimental-plugins';

/** Only an explicit boolean opt-in enables discovery, including during loading. */
export function integrationVisibility(
  resource: { get(property: string): unknown },
  properties: Record<string, string> = {},
) {
  return {
    showApiPlugins:
      !!properties['show-api-plugins'] &&
      resource.get(properties['show-api-plugins']) === true,
    showExperimentalPlugins:
      !!properties['show-experimental-plugins'] &&
      resource.get(properties['show-experimental-plugins']) === true,
  };
}

export type IntegrationVisibilityValues = Partial<
  Record<IntegrationVisibilityKey, boolean>
>;

const visibilityKeys: IntegrationVisibilityKey[] = [
  'show-api-plugins',
  'show-experimental-plugins',
];

/**
 * Preferences are cached per agent so a toggle shows up instantly on the next
 * visit, before (or without) the private drive being readable.
 */
function cacheKey(actor: string | undefined): string {
  return `integration-visibility:${actor ?? 'anonymous'}`;
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Reads the last known preferences for an agent. Never throws. */
export function readVisibilityCache(
  actor: string | undefined,
  storage: Storage | undefined = defaultStorage(),
): IntegrationVisibilityValues {
  try {
    const raw = storage?.getItem(cacheKey(actor));
    const parsed = raw ? JSON.parse(raw) : undefined;

    if (!parsed || typeof parsed !== 'object') return {};

    const values: IntegrationVisibilityValues = {};

    for (const key of visibilityKeys) {
      if (typeof parsed[key] === 'boolean') values[key] = parsed[key];
    }

    return values;
  } catch {
    return {};
  }
}

/** Merges preferences into the agent's cache. Never throws. */
export function writeVisibilityCache(
  actor: string | undefined,
  values: IntegrationVisibilityValues,
  storage: Storage | undefined = defaultStorage(),
): IntegrationVisibilityValues {
  const merged = { ...readVisibilityCache(actor, storage), ...values };

  try {
    storage?.setItem(cacheKey(actor), JSON.stringify(merged));
  } catch {
    // A full or blocked storage only costs us the head start, not the setting.
  }

  return merged;
}
