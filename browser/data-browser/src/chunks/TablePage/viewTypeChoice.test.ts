// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  canChangeViewType,
  canDeleteView,
  isDefaultViewName,
  nameAfterTypeChange,
  viewTypeKey,
} from './viewTypeChoice';

const APP = 'did:ad:app-calendar';

describe('viewTypeKey', () => {
  it('reads a missing or unknown kind as a table, and keeps an app subject', () => {
    expect(viewTypeKey(undefined)).toBe('table');
    expect(viewTypeKey('bogus')).toBe('table');
    expect(viewTypeKey('calendar')).toBe('calendar');
    expect(viewTypeKey(APP)).toBe(APP);
  });
});

describe('changing a view in place (#1806)', () => {
  it('is refused for the only table view, so choosing Calendar must add one', () => {
    const types = new Map([['t', 'table']]);

    expect(canChangeViewType('t', types)).toBe(false);
  });

  it('is refused for the last table view even when other views exist', () => {
    const types = new Map([
      ['t', 'table'],
      ['c', 'calendar'],
      ['k', 'kanban'],
    ]);

    expect(canChangeViewType('t', types)).toBe(false);
  });

  it('is allowed while another view of the same type remains', () => {
    const types = new Map([
      ['t1', 'table'],
      ['t2', 'table'],
    ]);

    expect(canChangeViewType('t1', types)).toBe(true);
  });

  it('keeps the only view of an app, too', () => {
    const types = new Map([
      ['t', 'table'],
      ['a', APP],
    ]);

    expect(canChangeViewType('a', types)).toBe(false);
  });
});

describe('deleting a view', () => {
  it('never removes the last table view while other views exist', () => {
    const types = new Map([
      ['t', 'table'],
      ['c', 'calendar'],
    ]);

    expect(canDeleteView('t', types)).toBe(false);
    expect(canDeleteView('c', types)).toBe(true);
  });

  it('allows deleting the only view: the implicit Table tab comes back', () => {
    expect(canDeleteView('t', new Map([['t', 'table']]))).toBe(true);
  });

  it('allows deleting one of two table views', () => {
    const types = new Map([
      ['t1', 'table'],
      ['t2', 'table'],
      ['c', 'calendar'],
    ]);

    expect(canDeleteView('t1', types)).toBe(true);
  });
});

describe('default view names', () => {
  it('treats given names as defaults', () => {
    expect(isDefaultViewName(undefined, 'table')).toBe(true);
    expect(isDefaultViewName('Default View', 'table')).toBe(true);
    expect(isDefaultViewName('Table', 'table')).toBe(true);
    expect(isDefaultViewName('Kanban', 'kanban')).toBe(true);
    // Template view names.
    expect(isDefaultViewName('All issues', 'table')).toBe(true);
    expect(isDefaultViewName('Board', 'kanban')).toBe(true);
    // The user-testing table: an assistant-built "All <rows>" table view.
    expect(isDefaultViewName('All pieces', 'table')).toBe(true);
    expect(isDefaultViewName('Ledger', APP, 'Ledger')).toBe(true);
  });

  it('keeps names a person chose', () => {
    expect(isDefaultViewName('Q3 launch', 'table')).toBe(false);
    expect(isDefaultViewName('Allotment', 'table')).toBe(false);
    // "All …" only reads as the everything-table on a table view.
    expect(isDefaultViewName('All hands', 'calendar')).toBe(false);
  });

  it('renames a converted default-named view after its new type', () => {
    expect(nameAfterTypeChange('All pieces', 'table', 'Calendar')).toBe(
      'Calendar',
    );
    expect(nameAfterTypeChange('Kanban', 'kanban', 'Timer')).toBe('Timer');
  });

  it('keeps a chosen name on conversion', () => {
    expect(
      nameAfterTypeChange('Editorial pipeline', 'table', 'Calendar'),
    ).toBeUndefined();
  });
});
