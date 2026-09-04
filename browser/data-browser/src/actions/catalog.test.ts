import { describe, expect, it } from 'vitest';
import { listShortcutHelp } from './catalog';
import { resourceActions } from './resourceActions';
import { appActions } from './appActions';
import { shortcuts } from './shortcuts';

describe('listShortcutHelp', () => {
  it('lists every action that carries a shortcut, from the registry', () => {
    const entries = listShortcutHelp();
    const ids = entries.map(entry => entry.id);

    expect(ids).toContain('search');
    expect(ids).toContain('keyboardShortcuts');
    expect(ids).toContain('edit');
    expect(ids).toContain('data');
    expect(ids).toContain('parent');
    expect(ids).toContain('menu');
    expect(ids).toContain('sidebarToggle');

    const parent = entries.find(entry => entry.id === 'parent');
    expect(parent?.shortcut).toBe(shortcuts.parent);
    expect(parent?.label).toBe('Go to parent');

    const edit = entries.find(entry => entry.id === 'edit');
    expect(edit?.label).toBe('Edit resource');
  });

  it('does not keep a parallel list — resource and app registries are the source', () => {
    const fromRegistries = [...appActions, ...resourceActions]
      .filter(action => action.shortcut)
      .map(action => action.id)
      .sort();
    const fromCatalog = listShortcutHelp()
      .map(entry => entry.id)
      .sort();

    expect(fromCatalog).toEqual(fromRegistries);
  });
});
