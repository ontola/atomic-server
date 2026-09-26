// @vitest-environment jsdom
// @wc-ignore-file
import React, { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';
import { DropdownPortalContext } from '@components/Dropdown/dropdownContext';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { ColumnFilterDropdown } from './ColumnFilterDropdown';

const openSearchOverlay = vi.fn();

vi.mock('@components/overlayState', () => ({
  openSearchOverlay: (q?: string) => openSearchOverlay(q),
}));

// jsdom has no layout; the menu scrolls its selected item into view.
Element.prototype.scrollIntoView = () => undefined;

afterEach(() => {
  cleanup();
  openSearchOverlay.mockReset();
});

const Trigger = buildDefaultTrigger(<span />, 'Filter');

function Harness() {
  const portal = useRef<HTMLDivElement>(null);

  return (
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <DropdownPortalContext.Provider value={portal}>
        <ColumnFilterDropdown
          Trigger={Trigger}
          items={[
            { id: 'title', label: 'Title', onClick: () => undefined },
            { id: 'day', label: 'Day', onClick: () => undefined },
          ]}
        />
        <div ref={portal} />
      </DropdownPortalContext.Provider>
    </ThemeProvider>
  );
}

/** Opens the menu and waits for it to be revealed (it is positioned first). */
async function openMenu() {
  const utils = render(<Harness />);
  fireEvent.click(utils.getByTitle('Filter'));
  const input = await utils.findByRole('textbox', {
    name: 'Find a column to filter by',
  });

  return { ...utils, input };
}

it('says its input finds a column, not a page', async () => {
  const { input } = await openMenu();

  expect(input.getAttribute('placeholder')).toBe('Find a column…');
});

it('lists matching columns and no search fallback while a column matches', async () => {
  const { input, queryByText } = await openMenu();

  fireEvent.change(input, { target: { value: 'da' } });

  expect(queryByText('Day')).not.toBeNull();
  expect(queryByText('No column matches')).toBeNull();
  expect(queryByText(/Search the drive/)).toBeNull();
});

it('offers to search the drive when nothing matches, on Enter too', async () => {
  const { input, getByText } = await openMenu();

  fireEvent.change(input, { target: { value: ' content plan ' } });

  expect(getByText('No column matches')).toBeTruthy();
  expect(getByText('Search the drive for “content plan”')).toBeTruthy();

  act(() => {
    fireEvent.keyDown(input, { key: 'Enter' });
  });

  expect(openSearchOverlay).toHaveBeenCalledWith('content plan');
});
