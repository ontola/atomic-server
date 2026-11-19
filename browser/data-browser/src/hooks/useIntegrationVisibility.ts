import {
  useCurrentAgent,
  useResource,
  useStore,
  useValue,
  type Store,
} from '@tomic/react';
import { useEffect, useRef, useState } from 'react';
import { usePrivateDrive } from './usePrivateDrive';
import {
  integrationVisibility,
  readPendingVisibility,
  readPreviewUnlocked,
  readVisibilityCache,
  visibilityProperties,
  writePendingVisibility,
  writePreviewUnlocked,
  writeVisibilityCache,
  type IntegrationVisibilityKey,
  type IntegrationVisibilityValues,
} from '@helpers/integrationVisibility';
import { retryDelayMs } from '@helpers/retryBackoff';

/**
 * Asks the server for the private drive again for as long as its read stays
 * failed. A read that timed out leaves an errored resource in the store's
 * cache, and `getResource` hands that same error back for as long as the tab is
 * open, so only going back to the server can heal it, and this panel's `ready`
 * gate reads that resource directly. Returns the function that stops asking.
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

/**
 * These preferences only decide what discovery shows, so the toggle is applied
 * locally right away and written to the private drive in the background. That
 * keeps the checkboxes usable while the server is still starting up.
 */
export function useIntegrationVisibility({
  unlockToggle = false,
}: {
  /** Unlock the experimental toggle for this agent on this device. */
  unlockToggle?: boolean;
} = {}) {
  const store = useStore();
  const [agent] = useCurrentAgent();
  const actor = agent?.subject;
  const { privateDrive, loading } = usePrivateDrive();
  const resource = useResource(loading ? undefined : privateDrive);
  const [saving, setSaving] = useState(false);
  /** Last known values for this agent, shown until the drive is readable. */
  const [local, setLocal] = useState<IntegrationVisibilityValues>(() =>
    readVisibilityCache(actor),
  );
  /** Toggles that are queued, in flight, or failed: the local value wins.
   * Restored from storage, so a reload right after a toggle resumes its
   * write rather than reverting to the drive's older value. */
  const [unconfirmed, setUnconfirmed] = useState<IntegrationVisibilityKey[]>(
    () => pendingKeys(readPendingVisibility(actor)),
  );
  const [queue, setQueue] = useState<IntegrationVisibilityValues>(() =>
    readPendingVisibility(actor),
  );
  /** A facilitator unlocked the experimental toggle on this device. */
  const [unlocked, setUnlocked] = useState(() => readPreviewUnlocked(actor));
  const flushing = useRef(false);
  const carriedFor = useRef<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string>();

  useEffect(() => {
    const pending = readPendingVisibility(actor);
    setUnlocked(readPreviewUnlocked(actor));
    setLocal(readVisibilityCache(actor));
    setUnconfirmed(pendingKeys(pending));
    setQueue(pending);
    setSaveError(undefined);
  }, [actor]);

  // One timed-out read of the private drive must not leave the panel unready
  // until the page is reloaded.
  const driveFailed = !!resource.error;

  useEffect(() => {
    if (!privateDrive || !driveFailed) return;

    return retryDriveRead(store, privateDrive);
  }, [store, privateDrive, driveFailed]);

  const ready =
    !loading && !!privateDrive && !resource.loading && !resource.error;
  // Read through `useValue`: a plain `resource.get` in render is not re-read
  // when a save changes the value, so this hook kept seeing the value from
  // before its own write.
  const [savedApi] = useValue(
    resource,
    visibilityProperties['show-api-plugins'],
  );
  const [savedExperimental] = useValue(
    resource,
    visibilityProperties['show-experimental-plugins'],
  );
  const stored = integrationVisibility({
    get: property =>
      property === visibilityProperties['show-api-plugins']
        ? savedApi
        : savedExperimental,
  });

  // Writes are queued rather than awaited, so a slow or unreachable server
  // never blocks the toggle that triggered them.
  useEffect(() => {
    const entries = Object.entries(queue) as [
      IntegrationVisibilityKey,
      boolean,
    ][];

    if (!ready || !actor || !privateDrive || flushing.current) return;

    if (entries.length === 0) return;

    flushing.current = true;
    setSaving(true);

    void saveVisibility(store, privateDrive, actor, entries).then(result => {
      flushing.current = false;
      setSaving(false);

      // Signing out or switching agents mid-write hands state to the effect
      // above, which reloads the preferences for whoever is signed in now.
      if (store.getAgent()?.subject !== actor) return;

      if (!result.error) {
        const remaining = dropSaved(readPendingVisibility(actor), entries);
        writePendingVisibility(actor, remaining);
        setUnconfirmed(current =>
          stillUnconfirmed(current, entries, remaining),
        );
      }

      // A failed write leaves the choice applied locally; only saving failed.
      setSaveError(result.error);
      setQueue(current => dropSaved(current, entries));
    });
  }, [ready, queue, actor, privateDrive, store]);

  // Choices made before these preferences had fixed properties live only in
  // this agent's cache: queue them so they land on the drive.
  useEffect(() => {
    if (!ready || !actor || !privateDrive) return;

    // Once per agent and drive: a carry-over is a migration, not a sync rule.
    const migration = `${actor}|${privateDrive}`;

    if (carriedFor.current === migration) return;
    carriedFor.current = migration;

    const carried = carryOver(
      {
        'show-api-plugins': savedApi,
        'show-experimental-plugins': savedExperimental,
      },
      readVisibilityCache(actor),
    );
    const fresh = pendingKeys(carried).filter(
      key => !unconfirmed.includes(key),
    );

    if (fresh.length === 0) return;

    writePendingVisibility(actor, {
      ...readPendingVisibility(actor),
      ...carried,
    });
    setUnconfirmed(current => [...current, ...fresh]);
    setQueue(current => ({ ...current, ...carried }));
  }, [ready, actor, privateDrive, savedApi, savedExperimental, unconfirmed]);

  // Once the drive is readable and in sync, it is the source of truth again.
  useEffect(() => {
    if (!ready) return;
    const carried = carryOver(
      {
        'show-api-plugins': savedApi,
        'show-experimental-plugins': savedExperimental,
      },
      readVisibilityCache(actor),
    );
    const confirmed: IntegrationVisibilityValues = {};

    if (
      !unconfirmed.includes('show-api-plugins') &&
      !carried['show-api-plugins']
    )
      confirmed['show-api-plugins'] = stored.showApiPlugins;

    if (
      !unconfirmed.includes('show-experimental-plugins') &&
      !carried['show-experimental-plugins']
    )
      confirmed['show-experimental-plugins'] = stored.showExperimentalPlugins;

    if (Object.keys(confirmed).length === 0) return;
    setLocal(writeVisibilityCache(actor, confirmed));
  }, [
    ready,
    actor,
    unconfirmed,
    savedApi,
    savedExperimental,
    stored.showApiPlugins,
    stored.showExperimentalPlugins,
  ]);

  const value = (key: IntegrationVisibilityKey, remote: boolean) =>
    ready && !unconfirmed.includes(key) ? remote : (local[key] ?? remote);

  useEffect(() => {
    if (!unlockToggle) return;
    writePreviewUnlocked(actor);
    setUnlocked(true);
  }, [unlockToggle, actor]);

  const setVisibility = (key: IntegrationVisibilityKey, next: boolean) => {
    // Whoever flips the switch keeps it, so it can't vanish under their cursor.
    if (key === 'show-experimental-plugins') {
      writePreviewUnlocked(actor);
      setUnlocked(true);
    }

    setLocal(writeVisibilityCache(actor, { [key]: next }));
    writePendingVisibility(actor, {
      ...readPendingVisibility(actor),
      [key]: next,
    });
    setUnconfirmed(current =>
      current.includes(key) ? current : [...current, key],
    );
    setQueue(current => ({ ...current, [key]: next }));
    setSaveError(undefined);
  };

  const showExperimentalPlugins = value(
    'show-experimental-plugins',
    stored.showExperimentalPlugins,
  );

  return {
    showApiPlugins: value('show-api-plugins', stored.showApiPlugins),
    showExperimentalPlugins,
    /** Plugins are handed out in user-testing sessions, so ordinary users get
     * no toggle. It stays for anyone who already opted in, and shows for
     * anyone who unlocked it on this device. */
    experimentalToggleVisible: showExperimentalPlugins || unlocked,
    ready,
    saving,
    pending: saving || Object.keys(queue).length > 0,
    error: saveError ?? (resource.error ? String(resource.error) : undefined),
    setVisibility,
  };
}

function pendingKeys(
  pending: IntegrationVisibilityValues,
): IntegrationVisibilityKey[] {
  return Object.keys(pending) as IntegrationVisibilityKey[];
}

/** Keeps entries that were changed again while the write was in flight. */
export function dropSaved(
  queued: IntegrationVisibilityValues,
  saved: [IntegrationVisibilityKey, boolean][],
): IntegrationVisibilityValues {
  const next = { ...queued };

  for (const [key, value] of saved) {
    if (next[key] === value) delete next[key];
  }

  return next;
}

/** A saved key is confirmed unless it was toggled again mid-flight, which
 * leaves it in the remaining pending values. */
export function stillUnconfirmed(
  current: IntegrationVisibilityKey[],
  saved: [IntegrationVisibilityKey, boolean][],
  remaining: IntegrationVisibilityValues,
): IntegrationVisibilityKey[] {
  return current.filter(
    key => key in remaining || !saved.some(([savedKey]) => savedKey === key),
  );
}

/**
 * Toggles to queue for the fixed properties: the drive has no value for a
 * preference yet but this agent's cache holds an opt-in, which was made before
 * the properties were fixed. Only `true` is carried; `false` is the default.
 */
export function carryOver(
  saved: Partial<Record<IntegrationVisibilityKey, unknown>>,
  cached: IntegrationVisibilityValues,
): IntegrationVisibilityValues {
  const carried: IntegrationVisibilityValues = {};

  for (const key of pendingKeys(cached)) {
    if (cached[key] === true && saved[key] === undefined) carried[key] = true;
  }

  return carried;
}

async function saveVisibility(
  store: Store,
  privateDrive: string,
  actor: string,
  entries: [IntegrationVisibilityKey, boolean][],
): Promise<{ error?: string }> {
  try {
    const drive = await store.getResource(privateDrive);

    // The agent may have changed while we waited for the server.
    if (store.getAgent()?.subject !== actor) return {};

    for (const [key, value] of entries) {
      await drive.set(visibilityProperties[key], value);
    }

    await drive.save();

    return {};
  } catch (reason) {
    return { error: String(reason) };
  }
}
