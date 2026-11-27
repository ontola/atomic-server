/** List of used keyboard shortcuts, mapped for OS. */
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
  // react-hotkeys-hook v5 matches on `event.code` (mapped through its key
  // table), so punctuation must be written as code names: pressing `?` gives
  // code "Slash", never "/". `shift+/` and `\` silently stopped matching in
  // the v4 → v5 upgrade, like the `cmd+` alias below.
  /** Open keyboard shortcuts page */
  keyboardShortcuts: 'shift+slash',
  /** Open command palette / search */
  search: osCtrl('k'),
  /** Open resource menu */
  menu: osCtrl('m'),
  /** Go to the parent of the current resource */
  parent: osCtrl('up'),
  /** Locks the sidebar menu */
  sidebarToggle: 'backslash',
  /** Move line up (documents) */
  moveLineUp: osAlt('up'),
  /** Move line down (documents) */
  moveLineDown: osAlt('down'),
  /** Delete line (documents) */
  deleteLine: osAlt('backspace'),
};

// A function declaration (hoisted: `shortcuts` above calls it while this module
// loads) with a regex, not a string: wuchale extracts 'Mac' as translatable text, and then
// `shortcuts` (computed when this module loads, before the catalog has) read the
// platform as not-Mac, so a Mac showed `ctrl+k`.
function isMac(): boolean {
  return /Mac/.test(navigator.platform);
}

function osCtrl(key: string): string {
  // react-hotkeys-hook v5 dropped the `cmd` modifier alias that v4 accepted —
  // it only recognizes `meta`/`mod`/`ctrl`/`control`. Emitting `cmd+…` meant
  // EVERY Cmd shortcut silently stopped matching on macOS (search, edit, new,
  // menu, …). Use `meta` for the Mac Cmd key.
  return isMac() ? `meta+${key}` : `ctrl+${key}`;
}

function osAlt(key: string): string {
  return isMac() ? `option+${key}` : `alt+${key}`;
}

export function displayShortcut(shortcut: string): string {
  // Code names → the character users see on their keyboard.
  const readable = shortcut
    .replace('shift+slash', '?')
    .replace('backslash', '\\');

  if (isMac()) {
    return readable
      .replace('meta+', '⌘')
      .replace('option+', '⌥')
      .replace('shift+', '⇧')
      .replace('backspace', '⌫')
      .replace('up', '↑')
      .replace('down', '↓');
  }

  return readable;
}
