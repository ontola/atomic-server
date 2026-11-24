// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { defaultUITheme } from '@tomic/ui/theme';
import { DropdownMenu, DIVIDER } from '@tomic/ui/components/Dropdown/index';
import { DropdownContainer } from '@tomic/ui/components/Dropdown/DropdownContainer';
import { AutoOpenTrigger } from '@tomic/ui/components/Dropdown/AutoOpenTrigger';
import type { DropdownTriggerProps } from '@tomic/ui/components/Dropdown/DropdownTrigger';

const pointer = { clientX: 120, clientY: 90 };
const theme = defaultUITheme as unknown as DefaultTheme;
const Trigger = ({ onClick, ref, id, menuId }: DropdownTriggerProps) => (
  <button id={id} aria-controls={menuId} ref={ref} onClick={onClick}>
    open
  </button>
);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  {
    name: 'searchable context menu',
    searchable: true,
    context: true,
    touch: false,
    detail: 1,
  },
  {
    name: 'non-searchable context menu',
    searchable: false,
    context: true,
    touch: false,
    detail: 1,
  },
  {
    name: 'button menu',
    searchable: true,
    context: false,
    touch: false,
    detail: 1,
  },
  {
    name: 'keyboard-opened button menu',
    searchable: true,
    context: false,
    touch: false,
    detail: 0,
  },
  {
    name: 'touch context menu',
    searchable: true,
    context: true,
    touch: true,
    detail: 1,
  },
])('$name', ({ searchable, context, touch, detail }) => {
  it('keeps keyboard selection through stationary pointer retargeting', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: touch }));
    const view = render(
      <ThemeProvider theme={theme}>
        <DropdownContainer>
          <DropdownMenu
            Trigger={context ? AutoOpenTrigger : Trigger}
            searchable={searchable}
            anchorPoint={
              context ? { x: pointer.clientX, y: pointer.clientY } : undefined
            }
            items={[
              { id: 'a', label: 'Alpha', onClick: vi.fn() },
              DIVIDER,
              {
                id: 'disabled',
                label: 'Disabled',
                disabled: true,
                onClick: vi.fn(),
              },
              { id: 'b', label: 'Beta', onClick: vi.fn() },
              { id: 'c', label: 'Gamma', onClick: vi.fn() },
            ]}
          />
        </DropdownContainer>
      </ThemeProvider>,
    );
    if (!context)
      fireEvent.click(view.getByText('open'), { ...pointer, detail });
    const menu = await view.findByRole('menu');
    await waitFor(() => expect(menu.style.visibility).toBe('visible'));

    if (searchable && !touch) {
      expect(document.activeElement).toBe(view.getByRole('textbox'));
    } else if (touch) {
      expect(document.activeElement).toBe(menu);
    }

    const selected = () => menu.querySelector('[data-selected="true"]');
    const press = (key: string) =>
      fireEvent.keyDown(document.activeElement!, { key });
    press('ArrowDown');
    const first = selected();
    expect(first).toBe(view.getByRole('menuitem', { name: 'Beta' }));

    // Scrolling/repositioning a menu can put a different child under the same
    // pointer. A new target alone is not a change from keyboard to mouse input.
    // A keyboard-opened trigger has no known pointer position: its first move
    // establishes that baseline without dropping the keyboard selection.
    const alpha = view.getByRole('menuitem', { name: 'Alpha' });
    fireEvent.mouseOver(alpha, pointer);
    fireEvent.mouseMove(alpha, pointer);
    expect(selected()).toBe(first);
    press('ArrowDown');
    const second = selected();
    expect(second).toBe(view.getByRole('menuitem', { name: 'Gamma' }));
    expect(second).not.toBe(first);
    fireEvent.mouseOver(alpha, pointer);
    fireEvent.mouseMove(alpha, pointer);
    expect(selected()).toBe(second);
    fireEvent.touchMove(alpha, { touches: [{ ...pointer }] });
    expect(selected()).toBe(second);

    fireEvent.mouseMove(alpha, { ...pointer, clientX: pointer.clientX + 1 });
    expect(selected()).toBeNull();
    press('ArrowDown');
    expect(selected()).toBe(alpha);
    press('Escape');
    expect(view.queryByRole('menu')).toBeNull();
  });
});

it('switches to mouse input on the first move after a real button click', async () => {
  const view = render(
    <ThemeProvider theme={theme}>
      <DropdownContainer>
        <DropdownMenu
          Trigger={Trigger}
          items={[
            { id: 'a', label: 'Alpha', onClick: vi.fn() },
            { id: 'b', label: 'Beta', onClick: vi.fn() },
          ]}
        />
      </DropdownContainer>
    </ThemeProvider>,
  );
  fireEvent.click(view.getByText('open'), { ...pointer, detail: 1 });
  const filter = await view.findByRole('textbox');
  await waitFor(() => expect(document.activeElement).toBe(filter));
  fireEvent.keyDown(filter, { key: 'ArrowDown' });
  const beta = view.getByRole('menuitem', { name: 'Beta' });
  expect(beta.getAttribute('data-selected')).toBe('true');

  // No mouseover or same-coordinate move initializes the position first.
  fireEvent.mouseMove(beta, { ...pointer, clientY: pointer.clientY + 1 });
  expect(
    view.getByRole('menu').querySelector('[data-selected="true"]'),
  ).toBeNull();
});
