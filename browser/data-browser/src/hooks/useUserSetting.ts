// @wc-ignore-file
import { useCanWrite, useResource, useValue, urls } from '@tomic/react';
import { useCallback, useEffect, useState } from 'react';
import { useLocalStorage } from './useLocalStorage';
import { usePrivateDrive } from './usePrivateDrive';

/** The settings that live on the personal drive, by name. */
export const userSettingProps = {
  onboardingPanelOpen: urls.properties.onboardingPanelOpen,
  welcomeDrive: urls.properties.welcomeDrive,
} as const;

type SettingValue = boolean | string | undefined;

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
): [T, (value: T) => void] {
  const { privateDrive } = usePrivateDrive();
  const drive = useResource(privateDrive);
  const canWrite = useCanWrite(drive);
  const [remote, setRemote] = useValue(drive, prop, { commit: true });
  const [local, setLocal] = useLocalStorage<T | undefined>(localKey, undefined);
  const writable = !!privateDrive && drive.isReady() && canWrite;

  // What was just chosen, shown until the drive has caught up with it: the
  // write waits on the property's definition and must not look like a dead click.
  const [pending, setPending] = useState<{ value: T }>();

  // Any change of the drive's value, ours landing or someone else's, ends it.
  useEffect(() => setPending(undefined), [remote]);

  useEffect(() => {
    if (writable && remote === undefined && local !== undefined) {
      void setRemote(local as never);
    }
  }, [writable, remote, local, setRemote]);

  const set = useCallback(
    (value: T) => {
      setPending({ value });
      setLocal(value);

      if (writable) void setRemote(value as never);
    },
    [setLocal, setRemote, writable],
  );

  return [pending ? pending.value : ((remote ?? local ?? fallback) as T), set];
}
