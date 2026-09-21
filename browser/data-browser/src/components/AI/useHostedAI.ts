import { useEffect, useState } from 'react';
import {
  getHostedAIStatus,
  HOSTED_AI_USAGE_EVENT,
  type HostedAIStatus,
} from '@helpers/managed/ai';
import { onManagedLogout } from '@helpers/managed/session';

export function useHostedAI() {
  const [status, setStatus] = useState<HostedAIStatus>();
  useEffect(() => {
    let generation = 0;
    let active = true;

    const refresh = async () => {
      const request = ++generation;

      try {
        const next = await getHostedAIStatus();
        if (active && generation === request) setStatus(next);
      } catch {
        // Preserve an existing balance during a transient outage. Requests are
        // always authorized and metered by the server, never by this display.
      }
    };

    void refresh();
    window.addEventListener(HOSTED_AI_USAGE_EVENT, refresh);
    window.addEventListener('focus', refresh);
    const removeLogout = onManagedLogout(() => {
      generation++;
      setStatus(undefined);
    });

    return () => {
      active = false;
      removeLogout();
      window.removeEventListener(HOSTED_AI_USAGE_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return { hostedAI: status, setHostedAI: setStatus };
}
