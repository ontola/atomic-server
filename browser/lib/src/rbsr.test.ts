import { describe, expect, it } from 'vitest';
import {
  itemFingerprint,
  reconcile,
  type Item,
  type RemoteRange,
} from './rbsr.js';

/** In-memory remote for tests — mirrors the Rust `MemRemote`. */
class MemRemote implements RemoteRange {
  private items_: Item[];

  constructor(items: Item[]) {
    this.items_ = [...items].sort((a, b) => (a.subject < b.subject ? -1 : 1));
  }

  async fingerprint(lo: string, hi?: string) {
    const { rangeFingerprint } = await import('./rbsr.js');

    return rangeFingerprint(this.items_, lo, hi);
  }

  async items(lo: string, hi?: string) {
    return this.items_.filter(
      ({ subject }) => subject >= lo && (hi === undefined || subject < hi),
    );
  }
}

const sorted = (items: Item[]) =>
  [...items].sort((a, b) => (a.subject < b.subject ? -1 : 1));

describe('RBSR (TS mirror of lib/src/sync/rbsr.rs)', () => {
  // GOLDEN CROSS-IMPLEMENTATION VECTOR — must equal Rust's
  // `item_fingerprint_matches_golden_vector`. The reconcile only converges if
  // both sides fingerprint an item identically.
  it('itemFingerprint matches the Rust golden vector', async () => {
    expect(await itemFingerprint('s', { p1: 1, p2: 2 })).toBe(
      '8b6067440e370aeaf5e85936d9d67477224a664f8b2811a2008309b590edd5d8',
    );
  });

  it('identical sets produce no diff', async () => {
    const items = sorted([
      { subject: 'a', vv: { p1: 1 } },
      { subject: 'b', vv: { p1: 2 } },
    ]);
    const diff = await reconcile(items, new MemRemote(items));
    expect(diff.onlyLocal).toEqual([]);
    expect(diff.onlyRemote).toEqual([]);
    expect(diff.differ).toEqual([]);
  });

  it('detects a changed VV, a local-only and a remote-only subject', async () => {
    const local = sorted([
      { subject: 'a', vv: { p1: 1 } },
      { subject: 'b', vv: { p1: 2 } },
      { subject: 'local', vv: { p1: 1 } },
    ]);
    const remote = new MemRemote([
      { subject: 'a', vv: { p1: 1 } },
      { subject: 'b', vv: { p1: 5 } }, // changed
      { subject: 'remote', vv: { p1: 1 } },
    ]);
    const diff = await reconcile(local, remote);
    expect(diff.differ).toEqual(['b']);
    expect(diff.onlyLocal).toEqual(['local']);
    expect(diff.onlyRemote).toEqual(['remote']);
  });

  it('finds one change in a large set without scanning everything', async () => {
    const n = 256;
    const base: Item[] = sorted(
      Array.from({ length: n }, (_, i) => ({
        subject: `subject-${String(i).padStart(4, '0')}`,
        vv: { p1: i },
      })),
    );
    const remoteItems = base.map(item =>
      item.subject === 'subject-0123'
        ? { subject: item.subject, vv: { p1: 9999 } }
        : item,
    );
    const diff = await reconcile(base, new MemRemote(remoteItems));
    expect(diff.differ).toEqual(['subject-0123']);
    expect(diff.onlyLocal).toEqual([]);
    expect(diff.onlyRemote).toEqual([]);
  });

  // Regression: when a range splits, its children have to tile `[lo, hi)`
  // exactly. Anchoring the first child at the first *local* key instead leaves
  // `[lo, firstLocal)` unvisited, so a subject the server has and this client
  // lacks — sorting below everything the client holds — is never pulled.
  // The Rust core carries the same pair of tests; they must not drift.
  it('finds a remote-only subject sorting below every local key', async () => {
    const local = sorted(
      ['b', 'c', 'd', 'e', 'f'].map(subject => ({ subject, vv: { p1: 1 } })),
    );
    const remote = new MemRemote([...local, { subject: 'a', vv: { p1: 1 } }]);

    const diff = await reconcile(local, remote, 4, 2);

    expect(diff.onlyRemote).toEqual(['a']);
    expect(diff.onlyLocal).toEqual([]);
    expect(diff.differ).toEqual([]);
  });

  it('finds one below everything through deep recursion', async () => {
    const local = sorted(
      Array.from({ length: 24 }, (_, i) => ({
        subject: `k${String(i).padStart(2, '0')}`,
        vv: { p1: 1 },
      })),
    );
    const remote = new MemRemote([...local, { subject: 'a', vv: { p1: 1 } }]);

    const diff = await reconcile(local, remote, 4, 2);

    expect(diff.onlyRemote).toEqual(['a']);
  });
});
