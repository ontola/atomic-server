import { useEffect, useRef } from 'react';
import { useOnline } from '../hooks/useOnline';
import toast from 'react-hot-toast';
import { StoreEvents, useStore } from '@tomic/react';

/**
 * No longer renders a visible element. Just shows friendly toasts
 * when connection state changes. The sync page handles detailed status.
 */
export function NetworkIndicator() {
  const isOnline = useOnline();
  const store = useStore();
  const wasEverConnected = useRef(false);

  useEffect(() => {
    const unsub = store.on(
      StoreEvents.ConnectionChanged,
      (connected: boolean) => {
        if (connected) {
          wasEverConnected.current = true;
          toast.success('Connected to server', { duration: 2000 });
        } else if (wasEverConnected.current) {
          toast('Working offline — your changes are saved locally', {
            icon: '\uD83D\uDCBE',
            duration: 4000,
          });
        }
      },
    );

    return unsub;
  }, [store]);

  useEffect(() => {
    if (!isOnline) {
      toast('No internet — your changes are saved locally', {
        icon: '\uD83D\uDCBE',
        duration: 4000,
      });
    }
  }, [isOnline]);

  return null;
}
