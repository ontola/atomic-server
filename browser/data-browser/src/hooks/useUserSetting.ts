// @wc-ignore-file
import { preferencesSchema } from '@tomic/lib';
import {
  useResourceSnapshot,
  useStore,
  useValue,
  type Store,
} from '@tomic/react';
import { useCallback, useEffect, useState } from 'react';
import { retryDelayMs } from '@helpers/retryBackoff';
import { useLocalStorage } from './useLocalStorage';
import { usePrivateDrive } from './usePrivateDrive';

/** The settings that live on the personal drive, by name. */
export const userSettingProps = {
  onboardingPanelOpen: preferencesSchema.properties.onboardingPanelOpen,
  welcomeDrive: preferencesSchema.properties.welcomeDrive,
  desktopDownloadOpened: preferencesSchema.properties.desktopDownloadOpened,
} as const;

type SettingValue = boolean | string | undefined;

/**
 * Asks the server for the private drive again for as long as its read stays
 * failed. A read that timed out leaves an errored resource in the store's
 * cache, and `getResource` hands that same error back for as long as the tab is
 * open, so only going back to the server can heal it. Returns the function
 * that stops asking.
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

/** How the drive side of a setting is doing. */
export type UserSettingStatus = {
  /** The personal drive is read and the setting shows its value. */
  ready: boolean;
  /** A write to the drive is in flight. */
  saving: boolean;
  /** The drive could not be read, or the last write failed. */
  error?: string;
};

/**
 * A per-user setting stored as a property on the signed-in agent's personal
 * drive, so it follows them to every device. `localKey` is the fallback: used
 * while the drive is loading, and kept as a cache of the last
 * value. A local value found while the drive has none is moved onto it once
 * the drive is readable, so existing devices keep their choice.
 */
export function useUserSetting<T extends SettingValue>(
  prop: string,
  localKey: string,
  fallback: T,
): [T, (value: T) => void, UserSettingStatus] {
  const store = useStore();
  const { privateDrive } = usePrivateDrive();
  // The snapshot's scalars, not `drive.isReady()`: the Resource object is
  // stable, so a compiled component would never read its loading change.
  const snapshot = useResourceSnapshot(privateDrive);
  const [remote] = useValue(snapshot.resource, prop);
  const [local, setLocal] = useLocalStorage<T | undefined>(localKey, undefined);
  const ready = !!privateDrive && snapshot.ready;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  // What was just chosen, shown until the drive has caught up with it: the
  // write waits on the property's definition and must not look like a dead click.
  const [pending, setPending] = useState<{ value: T }>();

  // Any change of the drive's value, ours landing or someone else's, ends it.
  useEffect(() => setPending(undefined), [remote]);

  // One timed-out read of the drive must not leave it unread until a reload.
  const driveFailed = !!snapshot.error;

  useEffect(() => {
    if (!privateDrive || !driveFailed) return;

    return retryDriveRead(store, privateDrive);
  }, [store, privateDrive, driveFailed]);

  const write = useCallback(
    (value: T) => {
      setSaving(true);
      setSaveError(undefined);
      // Awaited, so `saving` lasts until the drive has the value. A failed
      // write leaves the choice applied locally; only saving failed.
      (async () => {
        const resource = await store.getResource(privateDrive!);
        await resource.set(prop, value as never);
        await resource.save();
      })()
        .catch(reason => setSaveError(String(reason)))
        .finally(() => setSaving(false));
    },
    [store, privateDrive, prop],
  );

  useEffect(() => {
    if (ready && remote === undefined && local !== undefined) write(local);
  }, [ready, remote, local, write]);

  const set = useCallback(
    (value: T) => {
      setPending({ value });
      setLocal(value);

      if (ready) write(value);
    },
    [setLocal, write, ready],
  );

  return [
    pending ? pending.value : ((remote ?? local ?? fallback) as T),
    set,
    {
      ready,
      saving,
      error: saveError ?? (snapshot.error ? String(snapshot.error) : undefined),
    },
  ];
}
