// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ViewTab, ViewTabList } from './ViewTabs.js';

afterEach(cleanup);

function setup() {
  const rename = vi.fn();
  const select = vi.fn();

  function Host() {
    const [editing, setEditing] = useState(false);

    return (
      <ViewTabList aria-label='Views'>
        <ViewTab
          name='All rows'
          active
          editing={editing}
          onRename={rename}
          onEditingChange={setEditing}
          onClick={select}
          onDoubleClick={() => setEditing(true)}
        />
        <ViewTab
          name='Read only'
          active={false}
          disabled
          onRename={rename}
          onEditingChange={setEditing}
        />
      </ViewTabList>
    );
  }

  render(<Host />);

  return { rename, select };
}

it('renders without an Atomic store or host theme and delegates selection', () => {
  const { select } = setup();
  const tab = screen.getByRole('tab', { name: 'All rows' });
  expect(tab.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(tab);
  expect(select).toHaveBeenCalledOnce();
  expect(
    (screen.getByRole('tab', { name: 'Read only' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it('commits a trimmed rename exactly once on Enter or blur', () => {
  const { rename } = setup();
  fireEvent.doubleClick(screen.getByRole('tab', { name: 'All rows' }));
  const input = screen.getByRole('textbox', { name: 'Rename view' });
  fireEvent.change(input, { target: { value: '  My rows  ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.blur(input);
  expect(rename).toHaveBeenCalledExactlyOnceWith('My rows');
  fireEvent.doubleClick(screen.getByRole('tab', { name: 'All rows' }));
  const again = screen.getByRole('textbox', { name: 'Rename view' });
  fireEvent.change(again, { target: { value: 'Another name' } });
  fireEvent.blur(again);
  expect(rename).toHaveBeenLastCalledWith('Another name');
});

it('cancels with Escape and rejects blank or unchanged names', () => {
  const { rename } = setup();

  for (const [value, key] of [
    ['Cancelled', 'Escape'],
    ['  ', 'Enter'],
    ['All rows', 'Enter'],
  ]) {
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'All rows' }));
    const input = screen.getByRole('textbox', { name: 'Rename view' });
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key });
    expect(screen.getByRole('tab', { name: 'All rows' })).toBeTruthy();
  }

  expect(rename).not.toHaveBeenCalled();
});
