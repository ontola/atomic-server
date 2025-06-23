import React from 'react';
import { useSettings } from '../helpers/AppSettings';
import { GettingStartedFlow } from './getting-started/GettingStartedFlow';

/**
 * First-run experience: create an agent, set a name, auto-create a private home drive, then open it.
 * App chrome (sidebar, top bar, AI panel) is hidden on this route via NavWrapper.
 */
export const FullScreenNewIdentityPage: React.FC = () => {
  const { baseURL } = useSettings();

  return <GettingStartedFlow subject={baseURL} initialStep='create' />;
};
