// @wc-ignore-file
import { useSyncExternalStore } from 'react';
import {
  onManagedBindingChanged,
  readManagedAccountBinding,
} from '@helpers/managed/binding';
import { isDeviceLinked } from '@helpers/managed/deviceLink';
import { onManagedSessionChanged } from '@helpers/managed/session';
import { useHasManagedAccount } from './useHasManagedAccount';

const linked = () => !!readManagedAccountBinding() || isDeviceLinked();

const subscribe = (listener: () => void) => {
  const offs = [
    onManagedBindingChanged(listener),
    onManagedSessionChanged(listener),
  ];

  // Another tab can link or adopt (the email link opens in one): localStorage
  // tells this tab with a `storage` event, which the in-tab events never do.
  const onStorage = () => listener();

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }

  return () => {
    offs.forEach(off => off());

    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
};

/**
 * Whether this identity is saved to an account: the account adopted it, or
 * this device holds a link to one, or an account session exists. The one question behind the Getting started
 * "Save your work" step and the sidebar's guest row, and it follows a sign-in
 * without a reload.
 */
export function useIsLinkedToAccount(): boolean {
  const local = useSyncExternalStore(subscribe, linked, () => false);
  // Signing in with an email lands a cookie session, which leaves neither a
  // binding nor a device token; the account itself is the proof.
  const hasAccount = useHasManagedAccount();

  return local || hasAccount === true;
}
