// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { AssistantMessage } from './AssistantMessage';
import type { AtomicUIMessage } from '../types';

vi.mock('./FileContent', () => ({ FileContent: () => null }));
vi.mock('./MessageToolPart', () => ({ MessageToolPart: () => null }));
vi.mock('./SourceUrlPart', () => ({ SourceUrlPart: () => null }));
vi.mock('./ReasoningMessage', () => ({ ReasoningMessage: () => null }));
vi.mock('./BasicMessage', () => ({
  BasicMessage: ({ text }: { text: string }) => <p>{text}</p>,
}));

afterEach(cleanup);

const theme = {
  size: (n: number) => `${n * 8}px`,
  radius: '4px',
  colors: { alert: '#ff0000', text: '#000000' },
} as DefaultTheme;

const message: AtomicUIMessage = {
  id: 'failed-turn',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Partial reply' }],
  metadata: { error: 'Network error' },
};

it('shows a saved failure when no composer notice is present', () => {
  const view = render(
    <ThemeProvider theme={theme}>
      <AssistantMessage message={message} />
    </ThemeProvider>,
  );
  expect(view.getByRole('alert').textContent).toBe('Network error');
});

it('hides the duplicate error without hiding a partial answer', () => {
  const view = render(
    <ThemeProvider theme={theme}>
      <AssistantMessage message={message} hideError />
    </ThemeProvider>,
  );
  expect(view.queryByRole('alert')).toBeNull();
  expect(view.getByText('Partial reply')).toBeTruthy();
});
