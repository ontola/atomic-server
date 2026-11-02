// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { buildDefaultTrigger } from './DefaultTrigger';

afterEach(cleanup);

const theme = {
  animation: { duration: '0s' },
  colors: { text: '#000', bg1: '#eee', bg2: '#ddd' },
  radius: '4px',
} as unknown as DefaultTheme;

const triggerProps = {
  onClick: vi.fn(),
  menuId: 'resource-menu',
  isActive: false,
  ref: null,
  id: 'resource-menu-trigger',
};

describe('buildDefaultTrigger', () => {
  it('resolves a title callback at render time and updates the mounted button', () => {
    let title = 'Open resource menu';
    const resolveTitle = vi.fn(() => title);
    const Trigger = buildDefaultTrigger(
      <svg aria-hidden='true' />,
      resolveTitle,
    );

    expect(resolveTitle).not.toHaveBeenCalled();

    const { getByRole, rerender } = render(
      <ThemeProvider theme={theme}>
        <Trigger {...triggerProps} />
      </ThemeProvider>,
    );
    const button = getByRole('button', { name: 'Open resource menu' });

    title = 'Abrir menú del recurso';
    rerender(
      <ThemeProvider theme={theme}>
        <Trigger {...triggerProps} />
      </ThemeProvider>,
    );

    expect(getByRole('button', { name: 'Abrir menú del recurso' })).toBe(
      button,
    );
    expect(button.getAttribute('title')).toBe('Abrir menú del recurso');
  });

  it('keeps the default Open menu label when no title is provided', () => {
    const Trigger = buildDefaultTrigger(<svg aria-hidden='true' />);
    const { getByRole } = render(
      <ThemeProvider theme={theme}>
        <Trigger {...triggerProps} />
      </ThemeProvider>,
    );

    expect(
      getByRole('button', { name: 'Open menu' }).getAttribute('title'),
    ).toBe('Open menu');
  });

  it('keeps explicit string labels', () => {
    const Trigger = buildDefaultTrigger(<svg aria-hidden='true' />, 'Actions');
    const { getByRole } = render(
      <ThemeProvider theme={theme}>
        <Trigger {...triggerProps} />
      </ThemeProvider>,
    );

    expect(getByRole('button', { name: 'Actions' }).getAttribute('title')).toBe(
      'Actions',
    );
  });
});
