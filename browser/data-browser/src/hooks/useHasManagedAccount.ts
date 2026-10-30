import { useEffect, useState } from 'react';
import { hasManagedApi } from '../helpers/managed/api';
import {
  getManagedAccount,
  onManagedSessionChanged,
} from '../helpers/managed/session';

/**
 * Whether an atomic.place account session exists: `undefined` until the check
 * settled, then true or false. With no portal known there is nothing to ask,
 * which reads as `undefined` too (no answer, not "no account").
 */
export function useHasManagedAccount(): boolean | undefined {
  const [has, setHas] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      if (!hasManagedApi()) {
        setHas(undefined);

        return;
      }

      getManagedAccount()
        .then(account => {
          if (!cancelled) setHas(account !== null);
        })
        .catch(() => {
          // An unreachable portal is not proof of "no account".
          if (!cancelled) setHas(undefined);
        });
    };

    check();
    const off = onManagedSessionChanged(check);

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return has;
}
