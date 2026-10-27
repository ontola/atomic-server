import { describe, expect, it } from 'vitest';
import { contacts, core, type Resource } from '@tomic/react';
import {
  pendingInviteProps,
  pendingInviteQuery,
  toPendingInvite,
} from './pendingInvites';

const fake = (subject: string, props: Record<string, unknown>) =>
  ({ subject, get: (p: string) => props[p] }) as unknown as Resource;

describe('pendingInviteProps', () => {
  it('records address, target, role and time on the Contact', () => {
    expect(
      pendingInviteProps({
        email: 'a@b.nl',
        target: 'did:ad:x',
        role: 'write',
        sentAt: 5,
      }),
    ).toEqual({
      [core.properties.name]: 'a@b.nl',
      [contacts.properties.email]: 'a@b.nl',
      [contacts.properties.invitedTo]: 'did:ad:x',
      [contacts.properties.invitedRole]: 'write',
      [contacts.properties.invitedAt]: 5,
    });
  });
});

describe('pendingInviteQuery', () => {
  it('looks only in the private drive, for one target', () => {
    const q = pendingInviteQuery('did:ad:me', 'did:ad:x');

    expect(q.drive).toBe('did:ad:me');
    expect(q.value).toBe('did:ad:x');
  });
});

describe('toPendingInvite', () => {
  it('reads a Contact', () => {
    expect(
      toPendingInvite(
        fake('c1', {
          [contacts.properties.email]: 'a@b.nl',
          [contacts.properties.invitedRole]: 'write',
          [contacts.properties.invitedAt]: 7,
        }),
      ),
    ).toEqual({ subject: 'c1', email: 'a@b.nl', role: 'write', sentAt: 7 });
  });

  it('defaults to read and skips a Contact without an address', () => {
    expect(
      toPendingInvite(fake('c', { [contacts.properties.email]: 'a@b.nl' }))
        ?.role,
    ).toBe('read');
    expect(toPendingInvite(fake('c', {}))).toBeUndefined();
  });
});
