import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSettings } from '../helpers/AppSettings';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { clearHeartbeat, startLockHeartbeat } from '../helpers/deviceLock';
import { paths } from '../routes/paths';

/**
 * Keeps the device-lock heartbeat alive while the app is open, and locks the
 * moment an idle policy is exceeded.
 *
 * Without this, idle policies would only take effect on the *next* load — a
 * tab left open all afternoon would stay signed in, which is precisely the
 * case "lock after an hour" is asked for. Renders nothing.
 */
export function DeviceLockWatcher() {
  const { agent, setAgent, setDrive } = useSettings();
  const navigate = useNavigate();
  const subject = agent?.subject;

  useEffect(() => {
    if (!subject) return;

    return startLockHeartbeat(subject, () => {
      // Same shape as "Lock now": drop the usable agent, keep the account
      // session and the cached backup. Clear the heartbeat so the next load
      // is unambiguously locked rather than depending on how long the tab
      // took to close.
      clearHeartbeat();
      setAgent(undefined);
      setDrive('');
      void saveAgentToIDB(undefined);
      navigate({ to: paths.welcome, replace: true });
    });
  }, [subject, setAgent, setDrive, navigate]);

  return null;
}
