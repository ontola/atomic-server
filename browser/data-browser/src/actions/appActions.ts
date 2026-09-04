import { paths } from '../routes/paths';
import {
  openSearchOverlay,
  openShortcutsOverlay,
} from '../components/overlayState';
import { shortcuts } from './shortcuts';
import type { ActionDefinition } from './types';

/**
 * App-level actions (no target resource). Their shortcuts used to live only
 * in HotKeyWrapper; the help page and ⌘K now project this same list.
 */
export const appActions: ActionDefinition[] = [
  {
    id: 'search',
    scope: 'app',
    section: 'action',
    label: () => 'Open search',
    helper: () => 'Open the command palette to find resources and run actions.',
    keywords: ['find', 'palette', 'command'],
    shortcut: shortcuts.search,
    run: () => openSearchOverlay(),
  },
  {
    id: 'keyboardShortcuts',
    scope: 'app',
    section: 'action',
    label: () => 'Show keyboard shortcuts',
    helper: () => 'Open the list of keyboard shortcuts.',
    keywords: ['hotkeys', 'keys', 'help'],
    shortcut: shortcuts.keyboardShortcuts,
    run: () => openShortcutsOverlay(),
  },
  {
    id: 'home',
    scope: 'app',
    section: 'action',
    label: () => 'Go home',
    helper: () => 'Open the home page.',
    keywords: ['start', 'root'],
    shortcut: shortcuts.home,
    run: ctx => ctx.navigate('/'),
  },
  {
    id: 'new',
    scope: 'app',
    section: 'action',
    label: () => 'New resource',
    helper: () => 'Create a new resource.',
    keywords: ['create'],
    shortcut: shortcuts.new,
    run: ctx => ctx.navigate(paths.new),
  },
  {
    id: 'menu',
    scope: 'app',
    section: 'action',
    label: () => 'Open menu',
    helper: () => 'Open the actions menu for the current resource.',
    keywords: ['more', 'actions'],
    shortcut: shortcuts.menu,
    // The main ResourceContextMenu binds this shortcut itself (focus + filter).
    run: () => undefined,
  },
  {
    id: 'userSettings',
    scope: 'app',
    section: 'action',
    label: () => 'User settings',
    helper: () => 'Open your agent / user settings.',
    keywords: ['account', 'agent', 'profile'],
    shortcut: shortcuts.userSettings,
    run: ctx => ctx.navigate(paths.agentSettings),
  },
  {
    id: 'themeSettings',
    scope: 'app',
    section: 'action',
    label: () => 'Theme settings',
    helper: () => 'Open appearance and theme settings.',
    keywords: ['appearance', 'dark', 'light'],
    shortcut: shortcuts.themeSettings,
    run: ctx => ctx.navigate(paths.appSettings),
  },
  {
    id: 'sidebarToggle',
    scope: 'app',
    section: 'action',
    label: () => 'Show or hide the sidebar',
    helper: () => 'Lock or unlock the sidebar.',
    keywords: ['nav', 'panel'],
    shortcut: shortcuts.sidebarToggle,
    available: ctx => !!ctx.toggleSidebar,
    run: ctx => ctx.toggleSidebar?.(),
  },
];
