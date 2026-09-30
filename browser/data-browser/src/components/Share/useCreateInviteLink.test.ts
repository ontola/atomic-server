// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { inviteLinkPrefix } from './useCreateInviteLink';

describe('inviteLinkPrefix', () => {
  it('points at the server when the app is served by it', () => {
    expect(inviteLinkPrefix(window.location.origin)).toBe(
      `${window.location.origin}/app/invite?token=`,
    );
  });

  it('points at the app when it is served on its own port, as under Vite', () => {
    expect(inviteLinkPrefix('http://localhost:9885/')).toBe(
      `${window.location.origin}/app/invite?token=`,
    );
  });
});
