import { describe, expect, it } from 'vitest';
import {
  canonicalDriveHash,
  canonicalDriveHashV2,
} from './canonical-drive-hash.js';

describe('canonicalDriveHash', () => {
  // GOLDEN CROSS-IMPLEMENTATION VECTOR. The Rust server asserts the SAME hex
  // for the SAME logical input in `compute_drive_hash_matches_golden_vector`
  // (lib/src/sync/tests.rs). If either side's subject sort, counter encoding,
  // string format, or hash function drifts, one of the two tests fails — which
  // is the whole point: the SYNC_VV fast path only works if the two hashes are
  // byte-identical. Do NOT change this hex without changing both sides.
  it('matches the Rust golden vector', async () => {
    // Canonical string: "s1:2,0|s2:0,3" → SHA-256.
    expect(await canonicalDriveHash({ s1: [2, 0], s2: [0, 3] })).toBe(
      'de5fa2ae25000adf0d47d40b795e133c763328398301079ab56971d11862fbac',
    );
  });

  it('sorts subjects by code unit, not locale', async () => {
    // Uppercase sorts before lowercase by code unit (matches Rust byte order);
    // a locale-aware sort could interleave them and break the cross-impl match.
    const byInsertionOrder = await canonicalDriveHash({ b: [1], A: [1] });
    const byReversedInsertion = await canonicalDriveHash({ A: [1], b: [1] });
    expect(byInsertionOrder).toBe(byReversedInsertion);
  });
});

describe('canonicalDriveHashV2', () => {
  // The same vectors as `compute_drive_hash_v2_matches_golden_vectors` in
  // lib/src/sync/tests.rs. If one side changes, both fail.
  it('matches the Rust golden vectors', async () => {
    expect(await canonicalDriveHashV2({ s1: { p1: 2 }, s2: { p2: 3 } })).toBe(
      'f528a0cda4ba67df7ca7907ddee66b9535f0bf3719516a3ec9877b5b6ee4ea2a',
    );

    expect(
      await canonicalDriveHashV2({
        a: { p2: 4, p1: 1 },
        b: {},
        c: { p1: 7, p9: 0 },
      }),
    ).toBe('dd7b446967391a32dde347a6c1d24b8549e85362a19e44f4b0c1e48ea5137237');
  });

  it('does not depend on the order the entries were built in', async () => {
    expect(await canonicalDriveHashV2({ b: { y: 1, x: 2 }, a: { z: 3 } })).toBe(
      await canonicalDriveHashV2({ a: { z: 3 }, b: { x: 2, y: 1 } }),
    );
  });
});
