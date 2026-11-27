import { useCurrentAgent } from '@tomic/react';
import { useEffect, useState } from 'react';
import {
  carryOverLegacyOptIn,
  readPreviewUnlocked,
  visibilityLocalKey,
  visibilityProperties,
  writePreviewUnlocked,
  type IntegrationVisibilityKey,
} from '@helpers/integrationVisibility';
import { useUserSetting } from './useUserSetting';

function useVisibilitySetting(
  actor: string | undefined,
  key: IntegrationVisibilityKey,
) {
  carryOverLegacyOptIn(actor, key);

  return useUserSetting<boolean>(
    visibilityProperties[key],
    visibilityLocalKey(actor, key),
    false,
  );
}

/**
 * These preferences only decide what discovery shows, so a toggle is applied
 * locally right away and written to the private drive in the background (see
 * `useUserSetting`). Only an explicit `true` enables discovery.
 */
export function useIntegrationVisibility({
  unlockToggle = false,
}: {
  /** Unlock the experimental toggle for this agent on this device. */
  unlockToggle?: boolean;
} = {}) {
  const [agent] = useCurrentAgent();
  const actor = agent?.subject;
  const [showApiPlugins, setApi, api] = useVisibilitySetting(
    actor,
    'show-api-plugins',
  );
  const [showExperimentalPlugins, setExperimental, experimental] =
    useVisibilitySetting(actor, 'show-experimental-plugins');
  /** A facilitator unlocked the experimental toggle on this device. */
  const [unlocked, setUnlocked] = useState(() => readPreviewUnlocked(actor));

  useEffect(() => setUnlocked(readPreviewUnlocked(actor)), [actor]);

  useEffect(() => {
    if (!unlockToggle) return;
    writePreviewUnlocked(actor);
    setUnlocked(true);
  }, [unlockToggle, actor]);

  const setVisibility = (key: IntegrationVisibilityKey, next: boolean) => {
    // Whoever flips the switch keeps it, so it can't vanish under their cursor.
    if (key === 'show-experimental-plugins') {
      writePreviewUnlocked(actor);
      setUnlocked(true);
    }

    (key === 'show-api-plugins' ? setApi : setExperimental)(next);
  };

  const saving = api.saving || experimental.saving;

  return {
    // Strictly boolean: a stored non-boolean must not opt in.
    showApiPlugins: showApiPlugins === true,
    showExperimentalPlugins: showExperimentalPlugins === true,
    /** Plugins are handed out in user-testing sessions, so ordinary users get
     * no toggle. It stays for anyone who already opted in, and shows for
     * anyone who unlocked it on this device. */
    experimentalToggleVisible: showExperimentalPlugins === true || unlocked,
    ready: api.ready && experimental.ready,
    pending: saving,
    error: api.error ?? experimental.error,
    setVisibility,
  };
}
