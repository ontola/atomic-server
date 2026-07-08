import { describe, expect, it } from 'vitest';
import { canonicalDriveHash } from './canonical-drive-hash.js';

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
