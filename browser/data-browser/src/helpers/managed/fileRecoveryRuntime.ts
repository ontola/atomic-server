// @wc-ignore-file
import type { VaultBlobDb } from './vault';

type Guard = () => void | Promise<void>;

/** Snapshot the requested hashes before awaiting the current drive inventory. */
export async function scanMissingReferenced(
  db: Pick<VaultBlobDb, 'vaultFileHashes' | 'vaultBlobPresent'>,
  drive: string,
  candidates: Iterable<string> | undefined,
  guard: Guard,
  onResolved?: (hash: string, present: boolean) => void,
): Promise<string[]> {
  const selected =
    candidates && new Set([...candidates].map(hash => hash.toLowerCase()));
  await guard();
  const referenced = new Set(
    (await db.vaultFileHashes(drive)).map(hash => hash.toLowerCase()),
  );
  await guard();
  const missing: string[] = [];

  for (const hash of selected ?? referenced) {
    await guard();
    const present = referenced.has(hash) && (await db.vaultBlobPresent(hash));
    await guard();
    if (!referenced.has(hash) || present) onResolved?.(hash, present);
    else missing.push(hash);
  }

  return missing;
}

/** Bound the operation and its scope/session guard by the same cancellation. */
export async function recoveryAwait<T>(
  operation: Promise<T> | T,
  signal?: AbortSignal,
  guard?: Guard,
): Promise<T> {
  const result = await abortable(Promise.resolve(operation), signal);
  signal?.throwIfAborted();
  await abortable(
    Promise.resolve().then(() => guard?.()),
    signal,
  );
  signal?.throwIfAborted();

  return result;
}

export function recoveryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const delayed = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms);
  });

  return abortable(delayed, signal).finally(() => clearTimeout(timer));
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

  return Promise.race([operation, cancelled]).finally(() =>
    signal.removeEventListener('abort', abort),
  );
}
