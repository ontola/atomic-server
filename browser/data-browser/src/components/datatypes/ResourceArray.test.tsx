// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { allowLensEndpointKeysInRenders } from '@tomic/react';
import ResourceArray from './ResourceArray';

vi.mock('../../views/ResourceInline', () => ({
  ResourceInline: ({ subject }: { subject: string }) => (
    <span data-testid='inline'>{subject}</span>
  ),
}));

const KEY = 'record:APIs/todoist.com/1#task';
const CLASS =
  'https://ontola.github.io/atomic-plugins/ontology/classes/issue-v1';

afterEach(() => {
  allowLensEndpointKeysInRenders(() => false);
  cleanup();
});

it('shows a lens endpoint key as text while the split-pieces switch is on', () => {
  allowLensEndpointKeysInRenders(() => true);
  render(<ResourceArray subjects={[CLASS, KEY]} />);

  expect(screen.getByText(KEY).tagName).toBe('CODE');
  expect(screen.getAllByTestId('inline').map(el => el.textContent)).toEqual([
    CLASS,
  ]);
});

it('treats every entry as a subject while it is off', () => {
  render(<ResourceArray subjects={[CLASS, KEY]} />);

  expect(screen.getAllByTestId('inline').map(el => el.textContent)).toEqual([
    CLASS,
    KEY,
  ]);
});
