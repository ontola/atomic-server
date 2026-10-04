/**
 * Canonical drive-sync hash — the byte-identical counterpart of Rust's
 * `compute_drive_hash` (see `lib/src/sync/engine.rs` and
 * planning/drive-reconciliation.md Phase 1).
 *
 * BOTH implementations MUST produce identical output, or the SYNC_VV fast path
 * and the hash-first probe silently never match and every reconcile falls back
 * to a full diff. The spec, fixed here and mirrored in Rust:
 *
 *   - `resources`: subject → counter array. The counters are indexed by the
 *     sorted unique peer-id list, which the caller has already baked in.
 *   - Sort subjects by code unit (NOT `localeCompare`). Subject keys are ASCII
 *     (DIDs / URLs), so code-unit order equals Rust's byte-wise `str::cmp`;
 *     `localeCompare` is locale-aware and would order differently, which was
 *     the original silent divergence.
 *   - Per subject: `` `${subject}:${counters.join(',')}` ``.
 *   - Join subjects with `|`.
 *   - SHA-256 of the UTF-8 bytes, lower-case hex.
 *
 * A golden test vector on both sides (`canonical-drive-hash.test.ts` here,
 * `compute_drive_hash_matches_golden_vector` in Rust) pins them together.
 */
export async function canonicalDriveHash(
  resources: Record<string, number[]>,
): Promise<string> {
  const sortedEntries = Object.entries(resources).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const hashInput = sortedEntries
    .map(([s, c]) => `${s}:${c.join(',')}`)
    .join('|');
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(hashInput),
  );

  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Drive hash, version 2: the counterpart of Rust's `compute_drive_hash_v2`.
 *
 * Version 1 indexes every counter by the drive's sorted peer list, so the
 * string it hashes, and the `SYNC` frame that carries the same numbers, grow
 * with resources times peers. Every resource created on a client has a peer of
 * its own, which makes that R x R for a drive of R resources. This form lists
 * each resource's own non-zero counters and nothing else:
 *
 *   - `vvs`: subject → peer → counter. Zero counters do not count.
 *   - Sort subjects by code unit, and peers within a subject by code unit.
 *   - Per subject: `` `${subject}:${peer}=${counter},${peer}=${counter}` ``. A
 *     subject with no counters is `` `${subject}:` ``.
 *   - Join subjects with `|`.
 *   - SHA-256 of the UTF-8 bytes, lower-case hex.
 *
 * Golden vectors in `canonical-drive-hash.test.ts` and
 * `compute_drive_hash_v2_matches_golden_vectors` (Rust) pin them together.
 */
export async function canonicalDriveHashV2(
  vvs: Record<string, Record<string, number>>,
): Promise<string> {
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const hashInput = Object.keys(vvs)
    .sort(byCodeUnit)
    .map(subject => {
      const counters = Object.entries(vvs[subject])
        .filter(([, counter]) => counter !== 0)
        .sort(([a], [b]) => byCodeUnit(a, b))
        .map(([peer, counter]) => `${peer}=${counter}`)
        .join(',');

      return `${subject}:${counters}`;
    })
    .join('|');
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(hashInput),
  );

  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
