/**
 * Range-based set reconciliation (RBSR) — the byte-identical TS counterpart of
 * Rust's `lib/src/sync/rbsr.rs` (planning/drive-reconciliation.md Phase 2).
 *
 * Finds where two sorted `subject → version vector` sets differ by recursively
 * comparing range fingerprints, so a reconnect transfers only the differing
 * subjects instead of the whole drive's version vectors. The client drives this
 * against the server (via the `RemoteRange` async callbacks, which issue WS
 * queries); the server answers over `engine::drive_items`.
 *
 * Both implementations MUST fingerprint identically or the reconcile never
 * converges — a golden vector pins `itemFingerprint` to the Rust one.
 */

/** A subject's version vector: peer id → counter. */
export type VV = Record<string, number>;
/** One reconciliation item. */
export type Item = { subject: string; vv: VV };
/** A 32-byte fingerprint as lower-case hex (XOR-combined per range). */
export type Fingerprint = string;

/** Empty-range fingerprint (identity for XOR): 32 zero bytes. */
export const EMPTY_FP: Fingerprint = '00'.repeat(32);

/** Canonical per-item fingerprint: SHA-256 of `{subject}={peer:counter,…}` with
 *  the (peer, counter) pairs sorted by peer. Mirrors `rbsr::item_fingerprint`. */
export async function itemFingerprint(
  subject: string,
  vv: VV,
): Promise<Fingerprint> {
  const pairs = Object.keys(vv)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(p => `${p}:${vv[p]}`)
    .join(',');
  const bytes = new TextEncoder().encode(`${subject}=${pairs}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** XOR two hex fingerprints. */
function xorHex(a: Fingerprint, b: Fingerprint): Fingerprint {
  let out = '';

  for (let i = 0; i < 64; i += 2) {
    const byte =
      parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    out += byte.toString(16).padStart(2, '0');
  }

  return out;
}

/** Items whose subject is in `[lo, hi)` (hi `undefined` = unbounded above).
 *  `items` MUST be sorted by subject. */
function itemsInRange(items: Item[], lo: string, hi?: string): Item[] {
  return items.filter(
    ({ subject }) => subject >= lo && (hi === undefined || subject < hi),
  );
}

/** Fingerprint of the items in `[lo, hi)` — XOR of their per-item hashes. */
export async function rangeFingerprint(
  items: Item[],
  lo: string,
  hi?: string,
): Promise<Fingerprint> {
  let fp = EMPTY_FP;

  for (const { subject, vv } of itemsInRange(items, lo, hi)) {
    fp = xorHex(fp, await itemFingerprint(subject, vv));
  }

  return fp;
}

export type Diff = {
  onlyLocal: string[];
  onlyRemote: string[];
  differ: string[];
};

/** The remote side of the reconcile — issues real RPCs in production. */
export interface RemoteRange {
  fingerprint(lo: string, hi?: string): Promise<Fingerprint>;
  items(lo: string, hi?: string): Promise<Item[]>;
}

/** Reconcile the local set against a remote, returning the differing subjects.
 *  Mirrors `rbsr::reconcile`: matching ranges prune with zero transfer;
 *  mismatching ranges split until small enough to fetch and diff directly. */
export async function reconcile(
  local: Item[],
  remote: RemoteRange,
  split = 4,
  leaf = 4,
): Promise<Diff> {
  const out: Diff = { onlyLocal: [], onlyRemote: [], differ: [] };
  await reconcileRange(
    local,
    '',
    undefined,
    remote,
    Math.max(2, split),
    Math.max(1, leaf),
    out,
  );

  return out;
}

async function reconcileRange(
  local: Item[],
  lo: string,
  hi: string | undefined,
  remote: RemoteRange,
  split: number,
  leaf: number,
  out: Diff,
): Promise<void> {
  const localFp = await rangeFingerprint(local, lo, hi);
  const remoteFp = await remote.fingerprint(lo, hi);

  if (localFp === remoteFp) {
    return; // range matches — prune
  }

  const localSlice = itemsInRange(local, lo, hi);

  if (localSlice.length <= leaf) {
    diffSlices(localSlice, await remote.items(lo, hi), out);

    return;
  }

  const chunk = Math.ceil(localSlice.length / split);
  let idx = 0;

  while (idx < localSlice.length) {
    const chunkLo = localSlice[idx].subject;
    const next = Math.min(idx + chunk, localSlice.length);
    const chunkHi = next < localSlice.length ? localSlice[next].subject : hi;
    await reconcileRange(local, chunkLo, chunkHi, remote, split, leaf, out);
    idx = next;
  }
}

/** Merge-walk two subject-sorted slices, classifying each subject. */
function diffSlices(local: Item[], remote: Item[], out: Diff): void {
  let i = 0;
  let j = 0;

  while (i < local.length && j < remote.length) {
    const ls = local[i].subject;
    const rs = remote[j].subject;

    if (ls < rs) {
      out.onlyLocal.push(ls);
      i++;
    } else if (ls > rs) {
      out.onlyRemote.push(rs);
      j++;
    } else {
      if (!vvEqual(local[i].vv, remote[j].vv)) {
        out.differ.push(ls);
      }

      i++;
      j++;
    }
  }

  for (; i < local.length; i++) {
    out.onlyLocal.push(local[i].subject);
  }

  for (; j < remote.length; j++) {
    out.onlyRemote.push(remote[j].subject);
  }
}

function vvEqual(a: VV, b: VV): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);

  if (ak.length !== bk.length) {
    return false;
  }

  return ak.every(k => a[k] === b[k]);
}
