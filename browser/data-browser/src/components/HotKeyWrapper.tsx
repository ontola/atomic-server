// @wc-ignore-file
import * as React from 'react';
import { constructOpenURL, dataURL, editURL } from '../helpers/navigation';
import { useHotkeys } from 'react-hotkeys-hook';
import { useCurrentSubject } from '../helpers/useCurrentSubject';
import { Client, core, useStore } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { paths } from '../routes/paths';
import { openSearchOverlay, openShortcutsOverlay } from './OverlayContainer';

import type { JSX } from 'react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

type Props = {
  children: React.ReactNode;
};

/** List of used keyboard shortcuts, mapped for OS */
export const shortcuts = {
  /** Edit current resource */
  edit: osCtrl('e'),
  /** Show data view for current resource */
  data: osCtrl('d'),
  /** Show home page */
  home: osCtrl('h'),
  /** Create a new resource */
  new: osCtrl('n'),
  /** Open user settings page */
  userSettings: osCtrl('u'),
  /** Open theme settings page */
  themeSettings: osCtrl('t'),
  /** Open keyboard shortcuts page */
  keyboardShortcuts: 'shift+/',
  /** Open command palette / search */
  search: osCtrl('k'),
  /** Open resource menu */
  menu: osCtrl('m'),
  /** Go to the parent of the current resource */
  parent: osCtrl('up'),
  /** Locks the sidebar menu */
  sidebarToggle: '\\',
  /** Move line up (documents) */
  moveLineUp: osAlt('up'),
  /** Move line down (documents) */
  moveLineDown: osAlt('down'),
  /** Delete line (documents) */
  deleteLine: osAlt('backspace'),
};

function osCtrl(key: string): string {
  // react-hotkeys-hook v5 dropped the `cmd` modifier alias that v4 accepted —
  // it only recognizes `meta`/`mod`/`ctrl`/`control`. Emitting `cmd+…` meant
  // EVERY Cmd shortcut silently stopped matching on macOS (search, edit, new,
  // menu, …). Use `meta` for the Mac Cmd key.
  return navigator.platform.includes('Mac') ? `meta+${key}` : `ctrl+${key}`;
}

function osAlt(key: string): string {
  return navigator.platform.includes('Mac') ? `option+${key}` : `alt+${key}`;
}

export function displayShortcut(shortcut: string): string {
  if (navigator.platform.includes('Mac')) {
    return shortcut
      .replace('meta+', '⌘')
      .replace('option+', '⌥')
      .replace('shift+', '⇧')
      .replace('backspace', '⌫')
      .replace('up', '↑')
      .replace('down', '↓');
  }

  return shortcut;
}

/** App-wide keyboard events handler. */
function HotKeysWrapper({ children }: Props): JSX.Element {
  const navigate = useNavigateWithTransition();
  const [subject] = useCurrentSubject();
  const { sideBarLocked, setSideBarLocked } = useSettings();
  const store = useStore();

  useHotkeys(
    shortcuts.edit,
    e => {
      e.preventDefault();

      if (Client.isValidSubject(subject)) {
        navigate(editURL(subject!));
      }
    },
    {},
    [subject],
  );
  useHotkeys(
    shortcuts.data,
    e => {
      e.preventDefault();

      if (Client.isValidSubject(subject)) {
        navigate(dataURL(subject!));
      }
    },
    {},
    [subject],
  );
  useHotkeys(shortcuts.home, e => {
    e.preventDefault();
    navigate('/');
  });
  useHotkeys(
    shortcuts.parent,
    e => {
      e.preventDefault();

      if (!Client.isValidSubject(subject)) {
        return;
      }

      store.getResource(subject!).then(resource => {
        const parent = resource.get(core.properties.parent) as
          | string
          | undefined;

        if (parent) {
          navigate(constructOpenURL(parent));
        }
      });
    },
    {},
    [subject],
  );
  useHotkeys(shortcuts.new, e => {
    e.preventDefault();
    navigate(paths.new);
  });
  useHotkeys(shortcuts.userSettings, e => {
    e.preventDefault();
    navigate(paths.agentSettings);
  });
  useHotkeys(shortcuts.themeSettings, e => {
    e.preventDefault();
    navigate(paths.appSettings);
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

  return <>{children}</>;
}

export default HotKeysWrapper;
