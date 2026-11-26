import { useSettings } from '../helpers/AppSettings';
import { signOutEverywhere } from '../helpers/managed/signOut';

/**
 * Sign out of the account and this device, then clear what the app shows
 * (agent, drive). Where to go next is the caller's: it differs per screen.
 */
export function useSignOut() {
  const { agent, setAgent, setDrive } = useSettings();

  return async ({
    agentSubject = agent?.subject,
    forget,
  }: { agentSubject?: string; forget?: boolean } = {}) => {
    await signOutEverywhere({ agentSubject, forget });
    setAgent(undefined);
    // Empty, not the server origin: signed out, there is no workspace.
    setDrive('');
  };
}
