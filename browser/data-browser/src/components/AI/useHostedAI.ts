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
    let settlementRefresh: ReturnType<typeof setTimeout> | undefined;

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

    const refreshUsage = () => {
      void refresh();
      clearTimeout(settlementRefresh);
      // The server finishes metering even after the SDK cancels its stream.
      settlementRefresh = setTimeout(() => void refresh(), 1000);
    };

    void refresh();
    window.addEventListener(HOSTED_AI_USAGE_EVENT, refreshUsage);
    window.addEventListener('focus', refresh);
    const removeLogout = onManagedLogout(() => {
      generation++;
      clearTimeout(settlementRefresh);
      setStatus(undefined);
    });

    return () => {
      active = false;
      clearTimeout(settlementRefresh);
      removeLogout();
      window.removeEventListener(HOSTED_AI_USAGE_EVENT, refreshUsage);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return { hostedAI: status, setHostedAI: setStatus };
}
