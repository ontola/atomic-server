import {
  parsePluginRoutesStatus,
  useStore,
  type PluginRoutesStatus,
} from '@tomic/react';
import { useEffect, useState } from 'react';
import { NO_PLUGIN_ROUTES } from './catalogGate';

/**
 * This node's plugin-routes gates, from `/plugin-catalog`'s `hostFeatures`.
 * Only fetched when `enabled`: a review needs it only for a release that
 * opens public endpoints. `undefined` until it has loaded.
 */
export function usePluginRoutesStatus(
  enabled: boolean,
): PluginRoutesStatus | undefined {
  const store = useStore();
  const serverUrl = store.getServerUrl();
  const [status, setStatus] = useState<PluginRoutesStatus>();

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();

    void fetch(`${serverUrl}/plugin-catalog`, { signal: controller.signal })
      .then(response => (response.ok ? response.json() : undefined))
      .then(body => {
        if (!controller.signal.aborted)
          setStatus(parsePluginRoutesStatus(body) ?? NO_PLUGIN_ROUTES);
      })
      .catch(() => {
        // The server decides at install either way; the review then shows
        // its refusal instead of predicting it.
      });

    return () => controller.abort();
  }, [enabled, serverUrl]);

  return enabled ? status : undefined;
}
