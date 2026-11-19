// @wc-ignore-file
import {
  useCurrentAgent,
  useResource,
  useStore,
  useValue,
  type Store,
} from '@tomic/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { usePrivateDrive } from './usePrivateDrive';
import { useLocalStorage } from './useLocalStorage';
import {
  fromLegacy,
  mirrorKey,
  preferencesSnapshot,
  readCache,
  readLegacyField,
  readPending,
  subscribePreferences,
  toLegacy,
  writeStored,
  type PreferenceValue,
} from '@helpers/preferences';
import { retryDelayMs } from '@helpers/retryBackoff';

const NO_MIRROR = 'preference-without-mirror';

/** Drives being retried, shared so many preferences ask the server once. */
const retries = new Map<string, { users: number; stop: () => void }>();

/**
 * Asks the server for the private drive again for as long as its read stays
 * failed. A read that timed out leaves an errored resource in the store's
 * cache, and `getResource` hands that same error back for as long as the tab is
 * open, so only going back to the server can heal it. Returns the function that
 * stops asking.
 */
export function retryDriveRead(store: Store, privateDrive: string): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const schedule = () => {
    failures += 1;
    timer = setTimeout(async () => {
      const drive = await store
        .fetchResourceFromServer(privateDrive)
        .catch(() => undefined);

      if (active && (!drive || drive.error)) schedule();
    }, retryDelayMs(failures));
  };

  schedule();

  return () => {
    active = false;
    clearTimeout(timer);
  };
}

function retryWhileFailed(store: Store, privateDrive: string): () => void {
  const entry = retries.get(privateDrive) ?? {
    users: 0,
    stop: retryDriveRead(store, privateDrive),
  };

  entry.users += 1;
  retries.set(privateDrive, entry);

  return () => {
    entry.users -= 1;

    if (entry.users > 0) return;
    entry.stop();
    retries.delete(privateDrive);
  };
}

// One commit at a time, so preferences saved together build on each other's
// state instead of racing on the same resource.
let saves: Promise<unknown> = Promise.resolve();
const inFlight = new Set<string>();

function saveToDrive(
  store: Store,
  privateDrive: string,
  actor: string,
  property: string,
  value: PreferenceValue,
): Promise<{ error?: string }> {
  const run = async (): Promise<{ error?: string }> => {
    try {
      const drive = await store.getResource(privateDrive);

      // The agent may have changed while we waited for the server.
      if (store.getAgent()?.subject !== actor) return {};

      await drive.set(property, value);
      await drive.save();

      return {};
    } catch (reason) {
      return { error: String(reason) };
    }
  };

  const next = saves.then(run);

  saves = next;

  return next;
}

/**
 * One setting as data: a Property in the `preferences/v1` vocabulary, stored on
 * the person's private drive so it follows them to other devices and the
 * Flutter app. Applied locally at once and saved in the background, so it stays
 * usable while the server is starting up. Shown before the drive is readable
 * from this agent's cache, then from the setting's old localStorage key, then
 * `fallback`. Without an agent it is plain local storage.
 */
export function usePreferenceState<V extends PreferenceValue>(
  property: string,
  fallback: V,
) {
  const store = useStore();
  const [agent] = useCurrentAgent();
  const actor = agent?.subject;
  const { privateDrive, loading } = usePrivateDrive();
  const resource = useResource(loading ? undefined : privateDrive);
  // Read through `useValue`: a plain `resource.get` in render is not re-read
  // when a save changes the value.
  const [savedRaw] = useValue(resource, property);
  const mirror = mirrorKey(property);
  const [mirrored, setMirrored] = useLocalStorage<unknown>(
    mirror ?? NO_MIRROR,
    undefined,
  );
  /** What this hook last wrote to the old key, and the last value it saw there. */
  const written = useRef<unknown>(undefined);
  const seen = useRef(mirrored);
  const carried = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string>();
  useSyncExternalStore(subscribePreferences, () => preferencesSnapshot(actor));

  const ready =
    !loading && !!privateDrive && !resource.loading && !resource.error;
  const saved =
    typeof savedRaw === typeof fallback ? (savedRaw as V) : undefined;
  const cached = readCache(actor)[property] as V | undefined;
  const pending = readPending(actor)[property] as V | undefined;
  const legacy = mirror
    ? fromLegacy<V>(property, mirrored, fallback)
    : fromLegacy<V>(property, readLegacyField(property, actor), fallback);
  // The mirror is the device's latest choice, also when the host app wrote it.
  const stored = mirror ? (legacy ?? cached) : (cached ?? legacy);
  const value =
    pending !== undefined
      ? pending
      : ready && saved !== undefined
        ? saved
        : (stored ?? fallback);

  const write = useCallback(
    (next: V, toMirror: boolean) => {
      writeStored('cache', actor, property, next);

      if (mirror && toMirror) {
        written.current = toLegacy(property, next);
        setMirrored(written.current);
      }

      // Without an agent there is no drive to save to.
      if (actor) writeStored('pending', actor, property, next);
    },
    [actor, property, mirror, setMirrored],
  );

  const set = useCallback(
    (next: V) => {
      setError(undefined);
      write(next, true);
    },
    [write],
  );

  useEffect(() => {
    if (!privateDrive || !resource.error) return;

    return retryWhileFailed(store, privateDrive);
  }, [store, privateDrive, resource.error]);

  // The drive is the source of truth once readable and in sync.
  useEffect(() => {
    if (!ready || pending !== undefined || saved === undefined) return;

    if (cached !== saved) writeStored('cache', actor, property, saved);

    if (mirror && legacy !== saved) {
      written.current = toLegacy(property, saved);
      setMirrored(written.current);
    }
  }, [
    ready,
    pending,
    saved,
    cached,
    legacy,
    actor,
    property,
    mirror,
    setMirrored,
  ]);

  // A choice made before this preference synced, in the cache or its old key,
  // is queued once so it lands on the drive.
  useEffect(() => {
    if (!ready || !actor || pending !== undefined || saved !== undefined)
      return;

    const once = `${actor}|${privateDrive}`;

    if (carried.current === once) return;
    carried.current = once;

    if (stored !== undefined && stored !== fallback) write(stored, false);
  }, [ready, actor, privateDrive, pending, saved, stored, fallback, write]);

  // Someone else (the embed's host app) changed the old key.
  useEffect(() => {
    if (mirrored === seen.current) return;
    seen.current = mirrored;

    if (mirrored === written.current) return;

    if (legacy !== undefined && legacy !== value) set(legacy);
  }, [mirrored, legacy, value, set]);

  // Writes are queued rather than awaited, so a slow or unreachable server
  // never blocks the change that triggered them.
  useEffect(() => {
    const flight = `${actor}|${property}`;

    if (!ready || !actor || !privateDrive || pending === undefined) return;

    if (inFlight.has(flight)) return;
    inFlight.add(flight);

    void saveToDrive(store, privateDrive, actor, property, pending).then(
      result => {
        inFlight.delete(flight);

        // Signing out or switching agents mid-write hands state to whoever is
        // signed in now.
        if (store.getAgent()?.subject !== actor) return;

        if (!result.error && readPending(actor)[property] === pending)
          writeStored('pending', actor, property, undefined);

        // A failed write leaves the choice applied locally; only saving failed.
        setError(result.error);
      },
    );
  }, [ready, actor, privateDrive, property, pending, store]);

  return {
    value: value as V,
    set,
    ready,
    pending: pending !== undefined && !error,
    error: error ?? (resource.error ? String(resource.error) : undefined),
  };
}

export function usePreference(
  property: string,
  fallback: boolean,
): [boolean, (value: boolean) => void];
export function usePreference(
  property: string,
  fallback: string,
): [string, (value: string) => void];
export function usePreference(
  property: string,
  fallback: PreferenceValue,
): [PreferenceValue, (value: never) => void] {
  const { value, set } = usePreferenceState(property, fallback);

  return [value, set];
}
