import { useCurrentAgent } from '@tomic/react';
import {
  carryOverLegacyOptIn,
  visibilityLocalKey,
  visibilityProperties,
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
export function useIntegrationVisibility() {
  const [agent] = useCurrentAgent();
  const actor = agent?.subject;
  const [showApiPlugins, setApi, api] = useVisibilitySetting(
    actor,
    'show-api-plugins',
  );
  const [showExperimentalPlugins, setExperimental, experimental] =
    useVisibilitySetting(actor, 'show-experimental-plugins');
  const setVisibility = (key: IntegrationVisibilityKey, next: boolean) =>
    (key === 'show-api-plugins' ? setApi : setExperimental)(next);

  const saving = api.saving || experimental.saving;

  return {
    // Strictly boolean: a stored non-boolean must not opt in.
    showApiPlugins: showApiPlugins === true,
    showExperimentalPlugins: showExperimentalPlugins === true,
    ready: api.ready && experimental.ready,
    pending: saving,
    error: api.error ?? experimental.error,
    setVisibility,
  };
}
