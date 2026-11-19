// @wc-ignore-file
import { preferencesSchema } from '@tomic/lib';

export const preferenceProperties = preferencesSchema.properties;

export type PreferenceValue = boolean | string;

/**
 * Where a preference lived before it synced through the private drive, so
 * nobody loses their current choice. A plain `key` is a localStorage entry
 * that stays mirrored (the pre-paint script and the locale preload read it).
 * With a `field` it is one field of an object stored under `key`, read only.
 */
interface LegacySource {
  key: string | ((actor: string | undefined) => string);
  field?: string;
  /** Legacy value to the preference's value (the old theme names differ). */
  map?: Record<string, string>;
}

const oldVisibilityCache = (actor: string | undefined) =>
  `integration-visibility:${actor ?? 'anonymous'}`;

export const legacySources: Record<string, LegacySource> = {
  [preferenceProperties.theme]: {
    key: 'darkMode',
    map: { always: 'dark', never: 'light' },
  },
  [preferenceProperties.mainColor]: { key: 'mainColor' },
  [preferenceProperties.interfaceLanguage]: { key: 'atomic.locale' },
  [preferenceProperties.hideTemplates]: { key: 'hideTemplates' },
  [preferenceProperties.showSidebarIcons]: { key: 'showSidebarIcons' },
  [preferenceProperties.showApiPlugins]: {
    key: oldVisibilityCache,
    field: 'show-api-plugins',
  },
  [preferenceProperties.showExperimentalPlugins]: {
    key: oldVisibilityCache,
    field: 'show-experimental-plugins',
  },
};

/** The localStorage key kept in step with a preference, if it has one. */
export function mirrorKey(property: string): string | undefined {
  const source = legacySources[property];

  return source && !source.field && typeof source.key === 'string'
    ? source.key
    : undefined;
}

/** A legacy value in the preference's own terms; `undefined` if it doesn't fit. */
export function fromLegacy<T extends PreferenceValue>(
  property: string,
  raw: unknown,
  fallback: T,
): T | undefined {
  const value = legacySources[property]?.map?.[String(raw)] ?? raw;

  return typeof value === typeof fallback ? (value as T) : undefined;
}

export function toLegacy(property: string, value: PreferenceValue) {
  const map = legacySources[property]?.map ?? {};

  return (
    Object.entries(map).find(([, mapped]) => mapped === value)?.[0] ?? value
  );
}

/** A field of an old per-agent cache, for sources with a `field`. */
export function readLegacyField(
  property: string,
  actor: string | undefined,
): unknown {
  const source = legacySources[property];

  if (!source?.field || typeof source.key !== 'function') return undefined;

  return readValues(source.key(actor))[source.field];
}

// Storage that survives being blocked: a failed write lives on in memory.
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function readValues(key: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(read(key) ?? 'null');

    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const storeKey = (kind: 'cache' | 'pending', actor: string | undefined) =>
  `preferences${kind === 'cache' ? '' : '-pending'}:${actor ?? 'anonymous'}`;

/** Last known values for an agent, shown until the private drive is readable. */
export const readCache = (actor: string | undefined) =>
  readValues(storeKey('cache', actor));

/**
 * Choices not yet confirmed as saved to the private drive. They outlive the
 * page, so a reload right after a change resumes the write instead of letting
 * the drive's older value win.
 */
export const readPending = (actor: string | undefined) =>
  readValues(storeKey('pending', actor));

/** Sets (or, with `undefined`, removes) one value in an agent's cache or pending list. */
export function writeStored(
  kind: 'cache' | 'pending',
  actor: string | undefined,
  property: string,
  value: PreferenceValue | undefined,
): void {
  const key = storeKey(kind, actor);
  const next = { ...readValues(key), [property]: value };
  const raw = JSON.stringify(next);

  try {
    localStorage.setItem(key, raw);
  } catch {
    memory.set(key, raw);
  }

  listeners.forEach(listener => listener());
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);

  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** Changes whenever the agent's cache or pending list does. */
export const preferencesSnapshot = (actor: string | undefined) =>
  JSON.stringify([readCache(actor), readPending(actor)]);
