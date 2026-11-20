// @wc-ignore-file
import { preferencesSchema } from '@tomic/lib';
import {
  useCanWrite,
  useResource,
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
 * while the drive is loading or not writable, and kept as a cache of the last
 * value. A local value found while the drive has none is moved onto it once
 * the drive is writable, so existing devices keep their choice.
 */
export function useUserSetting<T extends SettingValue>(
  prop: string,
  localKey: string,
  fallback: T,
): [T, (value: T) => void, UserSettingStatus] {
  const store = useStore();
  const { privateDrive } = usePrivateDrive();
  const drive = useResource(privateDrive);
  const canWrite = useCanWrite(drive);
  const [remote, setRemote] = useValue(drive, prop, { commit: true });
  const [local, setLocal] = useLocalStorage<T | undefined>(localKey, undefined);
  const ready = !!privateDrive && drive.isReady();
  const writable = ready && canWrite;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  // What was just chosen, shown until the drive has caught up with it: the
  // write waits on the property's definition and must not look like a dead click.
  const [pending, setPending] = useState<{ value: T }>();

  // Any change of the drive's value, ours landing or someone else's, ends it.
  useEffect(() => setPending(undefined), [remote]);

  // One timed-out read of the drive must not leave it unread until a reload.
  const driveFailed = !!drive.error;

  useEffect(() => {
    if (!privateDrive || !driveFailed) return;

    return retryDriveRead(store, privateDrive);
  }, [store, privateDrive, driveFailed]);

  const write = useCallback(
    (value: T) => {
      setSaving(true);
      setSaveError(undefined);
      // A failed write leaves the choice applied locally; only saving failed.
      Promise.resolve(setRemote(value as never))
        .catch(reason => setSaveError(String(reason)))
        .finally(() => setSaving(false));
    },
    [setRemote],
  );

  useEffect(() => {
    if (writable && remote === undefined && local !== undefined) write(local);
  }, [writable, remote, local, write]);

  const set = useCallback(
    (value: T) => {
      setPending({ value });
      setLocal(value);

      if (writable) write(value);
    },
    [setLocal, write, writable],
  );

  return [
    pending ? pending.value : ((remote ?? local ?? fallback) as T),
    set,
    {
      ready,
      saving,
      error: saveError ?? (drive.error ? String(drive.error) : undefined),
    },
  ];
}
