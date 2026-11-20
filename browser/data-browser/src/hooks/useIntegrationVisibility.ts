import { useCurrentAgent } from '@tomic/react';
import { useEffect, useState } from 'react';
import {
  readPreviewUnlocked,
  writePreviewUnlocked,
} from '@helpers/integrationVisibility';
import { preferenceProperties } from '@helpers/preferences';
import { usePreferenceState } from './usePreference';

/**
 * These preferences only decide what discovery shows. They are ordinary
 * synced preferences (see `usePreference`); this adds the experimental
 * toggle's unlock.
 */
export function useIntegrationVisibility({
  unlockToggle = false,
}: {
  /** Unlock the experimental toggle for this agent on this device. */
  unlockToggle?: boolean;
} = {}) {
  const [agent] = useCurrentAgent();
  const actor = agent?.subject;
  const api = usePreferenceState<boolean>(
    preferenceProperties.showApiPlugins,
    false,
  );
  const experimental = usePreferenceState<boolean>(
    preferenceProperties.showExperimentalPlugins,
    false,
  );
  /** A facilitator unlocked the experimental toggle on this device. */
  const [unlocked, setUnlocked] = useState(() => readPreviewUnlocked(actor));
  const showExperimentalPlugins = experimental.value;

  useEffect(() => setUnlocked(readPreviewUnlocked(actor)), [actor]);

  // Whoever has the switch on keeps it, so it can't vanish under their cursor.
  useEffect(() => {
    if (!unlockToggle && !showExperimentalPlugins) return;
    writePreviewUnlocked(actor);
    setUnlocked(true);
  }, [unlockToggle, showExperimentalPlugins, actor]);

  return {
    showApiPlugins: api.value,
    showExperimentalPlugins,
    /** Plugins are handed out in user-testing sessions, so ordinary users get
     * no toggle. It stays for anyone who already opted in, and shows for
     * anyone who unlocked it on this device. */
    experimentalToggleVisible: showExperimentalPlugins || unlocked,
    ready: experimental.ready,
    pending: api.pending || experimental.pending,
    error: experimental.error ?? api.error,
  };
}
