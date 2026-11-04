import { useSyncExternalStore } from 'react';

/**
 * A one-time hint on the drive switcher, right after a drive was created.
 * In memory on purpose: it belongs to that one creation, not to the device.
 */
let pending = false;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(l => l());

/** Called by drive creation when there was a previous drive to go back to. */
export function showDriveSwitcherHint(): void {
  pending = true;
  emit();
}

export function dismissDriveSwitcherHint(): void {
  if (!pending) return;
  pending = false;
  emit();
}

export function useDriveSwitcherHint(): boolean {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb);

      return () => listeners.delete(cb);
    },
    () => pending,
  );
}
