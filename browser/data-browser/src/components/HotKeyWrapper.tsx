// @wc-ignore-file
import * as React from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { Client } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { useCurrentSubject } from '../helpers/useCurrentSubject';
import { appActions } from '../actions/appActions';
import { resourceActions } from '../actions/resourceActions';
import { runAction } from '../actions/runAction';
import { useActionContext } from '../actions/useActionContext';
import { shortcuts } from '../actions/shortcuts';
import { openSearchOverlay, openShortcutsOverlay } from './overlayState';

import type { JSX } from 'react';

export { shortcuts, displayShortcut } from '../actions/shortcuts';

type Props = {
  children: React.ReactNode;
};

const resourceHotkeys = resourceActions.filter(
  (action): action is (typeof resourceActions)[number] & { shortcut: string } =>
    Boolean(action.shortcut),
);

function ResourceActionHotkey({
  action,
  subject,
  ctx,
}: {
  action: (typeof resourceHotkeys)[number];
  subject: string | undefined;
  ctx: ReturnType<typeof useActionContext>;
}): null {
  useHotkeys(
    action.shortcut,
    e => {
      e.preventDefault();

      if (!Client.isValidSubject(subject)) {
        return;
      }

      if (!(action.available?.(ctx) ?? true)) {
        return;
      }

      if (action.disabled?.(ctx)) {
        return;
      }

      runAction(action, ctx);
    },
    {},
    [subject, ctx, action],
  );

  return null;
}

/** App-wide keyboard events handler. Resource verbs run the registry action. */
function HotKeysWrapper({ children }: Props): JSX.Element {
  const [subject] = useCurrentSubject();
  const { sideBarLocked, setSideBarLocked } = useSettings();
  const ctx = useActionContext(subject ?? '', {
    toggleSidebar: () => setSideBarLocked(!sideBarLocked),
  });

  const home = appActions.find(action => action.id === 'home')!;
  const createNew = appActions.find(action => action.id === 'new')!;
  const userSettings = appActions.find(action => action.id === 'userSettings')!;
  const themeSettings = appActions.find(
    action => action.id === 'themeSettings',
  )!;

  useHotkeys(home.shortcut!, e => {
    e.preventDefault();
    runAction(home, ctx);
  });
  useHotkeys(createNew.shortcut!, e => {
    e.preventDefault();
    runAction(createNew, ctx);
  });
  useHotkeys(userSettings.shortcut!, e => {
    e.preventDefault();
    runAction(userSettings, ctx);
  });
  useHotkeys(themeSettings.shortcut!, e => {
    e.preventDefault();
    runAction(themeSettings, ctx);
  });
  useHotkeys(shortcuts.search, e => {
    e.preventDefault();
    openSearchOverlay();
  });
  useHotkeys(shortcuts.keyboardShortcuts, e => {
    e.preventDefault();
    openShortcutsOverlay();
  });
  useHotkeys(
    shortcuts.sidebarToggle,
    e => {
      e.preventDefault();
      setSideBarLocked(!sideBarLocked);
    },
    {},
    [sideBarLocked],
  );

  return (
    <>
      {resourceHotkeys.map(action => (
        <ResourceActionHotkey
          key={action.id}
          action={action}
          subject={subject}
          ctx={ctx}
        />
      ))}
      {children}
    </>
  );
}

export default HotKeysWrapper;
