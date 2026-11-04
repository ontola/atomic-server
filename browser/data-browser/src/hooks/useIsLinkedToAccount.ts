// @wc-ignore-file
import { useSyncExternalStore } from 'react';
import {
  onManagedBindingChanged,
  readManagedAccountBinding,
} from '@helpers/managed/binding';
import { isDeviceLinked } from '@helpers/managed/deviceLink';
import { onManagedSessionChanged } from '@helpers/managed/session';

const linked = () => !!readManagedAccountBinding() || isDeviceLinked();

const subscribe = (listener: () => void) => {
  const offs = [
    onManagedBindingChanged(listener),
    onManagedSessionChanged(listener),
  ];

  return () => offs.forEach(off => off());
};

/**
 * Whether this identity is saved to an account: the account adopted it, or
 * this device holds a link to one. The one question behind the Getting started
 * "Save your work" step and the sidebar's guest row, and it follows a sign-in
 * without a reload.
 */
export function useIsLinkedToAccount(): boolean {
  return useSyncExternalStore(subscribe, linked, () => false);
}
