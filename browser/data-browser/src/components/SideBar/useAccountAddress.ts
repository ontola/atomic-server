// @wc-ignore-file
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  onManagedBindingChanged,
  readManagedAccountBinding,
} from '@helpers/managed/binding';
import { hasManagedApi } from '@helpers/managed/api';
import {
  accountAddress,
  getManagedAccount,
  onManagedSessionChanged,
} from '@helpers/managed/session';
import { pickAccountAddress } from './accountRowName';

const readBindingEmail = () => readManagedAccountBinding()?.owner_email;

/**
 * The address of the account this identity belongs to: the signed-in
 * session's display address, else the binding's email. Never an `acct_` id.
 * Follows sign-in and sign-out without a reload.
 */
export function useAccountAddress(): string | undefined {
  const bindingEmail = useSyncExternalStore(
    onManagedBindingChanged,
    readBindingEmail,
    () => undefined,
  );
  const [sessionAddress, setSessionAddress] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      if (!hasManagedApi()) {
        setSessionAddress(undefined);

        return;
      }

      getManagedAccount()
        .then(account => {
          if (!cancelled) {
            setSessionAddress(account ? accountAddress(account) : undefined);
          }
        })
        .catch(() => {
          if (!cancelled) setSessionAddress(undefined);
        });
    };

    check();
    const off = onManagedSessionChanged(check);

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return pickAccountAddress(sessionAddress, bindingEmail);
}
