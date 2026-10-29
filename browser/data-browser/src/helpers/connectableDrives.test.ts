import { describe, expect, it } from 'vitest';
import { grantFailureMessage, unreachableDrives } from './connectableDrives';

const store = (local: string[] = []) => ({
  isLocalOnlyDrive: (s: string) => local.includes(s),
  normalizeSubject: (s: string) => s.replace(/\/$/, ''),
});

describe('unreachableDrives', () => {
  const drives = ['did:ad:a', 'did:ad:b', 'did:ad:c'];

  it('leaves every drive available when enrollments are unknown', () => {
    expect(unreachableDrives(store(), drives, undefined)).toEqual([]);
  });

  it('always flags browser-only drives', () => {
    expect(unreachableDrives(store(['did:ad:b']), drives, undefined)).toEqual([
      'did:ad:b',
    ]);
  });

  it('flags drives no enrollment hosts, comparing normalised subjects', () => {
    const enrollments = [
      { drive_subject: 'did:ad:a/', status: 'Active' },
      { drive_subject: 'did:ad:b', status: 'Disabled' },
    ];

    expect(unreachableDrives(store(), drives, enrollments)).toEqual([
      'did:ad:b',
      'did:ad:c',
    ]);
  });

  it('treats a pending or paused enrollment as hosted', () => {
    const enrollments = drives.map((d, i) => ({
      drive_subject: d,
      status: ['Pending', 'Suspended', 'Error'][i],
    }));

    expect(unreachableDrives(store(), drives, enrollments)).toEqual([]);
  });

  it('flags a drive hosted on another node than the one connecting', () => {
    const enrollments = [
      {
        drive_subject: 'did:ad:a',
        status: 'Active',
        http_origin: 'https://node1.example',
      },
      {
        drive_subject: 'did:ad:b',
        status: 'Active',
        http_origin: 'https://node2.example',
      },
      { drive_subject: 'did:ad:c', status: 'Active' },
    ];

    expect(
      unreachableDrives(store(), drives, enrollments, 'https://node1.example/'),
    ).toEqual(['did:ad:b']);
  });
});

describe('grantFailureMessage', () => {
  const titleOf = (s: string) => (s === 'did:ad:a' ? 'Private' : 'Team');
  const refusal = new Error(
    'Drive did:ad:a is not enrolled for sync on this node.',
  );

  it('names a refused drive by title and says what to do', () => {
    const message = grantFailureMessage(
      [{ subject: 'did:ad:a', error: refusal }],
      titleOf,
      'Claude',
      'atomic.example',
    );

    expect(message).toBe(
      'Private only lives on your devices, so Claude cannot reach it through atomic.example. Deselect it, or turn on Cloud Server for that drive.',
    );
    expect(message).not.toContain('did:ad');
  });

  it('reports other failures separately', () => {
    const message = grantFailureMessage(
      [
        { subject: 'did:ad:a', error: refusal },
        { subject: 'did:ad:b', error: new Error('Forbidden') },
      ],
      titleOf,
      'Claude',
      'node',
    );

    expect(message).toContain('Private only lives');
    expect(message).toContain(
      'Could not give Claude access to Team: Forbidden',
    );
  });
});
