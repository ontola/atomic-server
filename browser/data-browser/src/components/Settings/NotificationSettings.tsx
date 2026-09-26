import { useState } from 'react';
import { Column } from '../Row';
import { Checkbox, CheckboxLabel } from '../forms/Checkbox';
import {
  osNotificationState,
  turnOffOsNotifications,
  turnOnOsNotifications,
  type OsNotificationState,
} from '../../helpers/notifications/osNotifications';

/**
 * The per-device switch for OS notifications. In-app toasts need no
 * permission and are always on.
 */
export function NotificationSettings() {
  const [state, setState] = useState<OsNotificationState>(osNotificationState);

  const onChange = async (checked: boolean) => {
    if (checked) {
      setState(await turnOnOsNotifications());
    } else {
      turnOffOsNotifications();
      setState(osNotificationState());
    }
  };

  return (
    <Column gap='0.5rem'>
      <p>
        You get a notification for new chat messages, comments on things you
        made, and replies to you. While you're in the app it shows in the
        corner; otherwise it comes from your system.
      </p>
      {state === 'unsupported' ? (
        <p>This browser can't show system notifications.</p>
      ) : (
        <CheckboxLabel>
          <Checkbox
            checked={state === 'on'}
            onChange={checked => void onChange(checked)}
            disabled={state === 'blocked'}
          />{' '}
          <span>Show system notifications on this device</span>
        </CheckboxLabel>
      )}
      {state === 'blocked' && (
        <p>
          Notifications are blocked for this site. Allow them in your browser or
          system settings, then come back here.
        </p>
      )}
    </Column>
  );
}
