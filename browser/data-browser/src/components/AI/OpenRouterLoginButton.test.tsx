// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { OpenRouterLoginButton } from './OpenRouterLoginButton';

vi.mock('../ButtonLink', () => ({
  ButtonLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{props.children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it('does not replace an in-progress verifier when another login button mounts', () => {
  localStorage.setItem(
    'atomic.ai.openrouter-code-verifier',
    'pending-verifier',
  );
  render(
    <>
      <OpenRouterLoginButton />
      <OpenRouterLoginButton />
    </>,
  );
  expect(localStorage.getItem('atomic.ai.openrouter-code-verifier')).toBe(
    'pending-verifier',
  );
});

it('stores the verifier belonging to the clicked link, with a valid PKCE length', () => {
  const view = render(
    <>
      <OpenRouterLoginButton />
      <OpenRouterLoginButton />
    </>,
  );
  const link = view.getAllByRole('link')[0];
  // Prevent jsdom navigation, after React's click handler has run.
  document.addEventListener('click', event => event.preventDefault(), {
    once: true,
  });
  fireEvent.click(link);
  const verifier = localStorage.getItem('atomic.ai.openrouter-code-verifier')!;
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  const challenge = btoa(
    String.fromCharCode(...sha256(new TextEncoder().encode(verifier))),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  expect(
    new URL(link.getAttribute('href')!).searchParams.get('code_challenge'),
  ).toBe(challenge);
});

it('keeps the user on the page and shows an error when storage is blocked', () => {
  const view = render(<OpenRouterLoginButton />);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage blocked', 'SecurityError');
  });
  expect(fireEvent.click(view.getByRole('link'))).toBe(false);
  expect(view.getByRole('alert').textContent).toContain(
    'Allow browser storage',
  );
});
