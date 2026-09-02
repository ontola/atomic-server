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
