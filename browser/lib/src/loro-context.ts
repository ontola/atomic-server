import type { LoroDoc } from 'loro-crdt';

/**
 * What was being done to a Loro doc when it threw. Sizes and a verb only:
 * never a subject, a name or any content, so error reporting can attach it
 * as tags.
 */
export interface LoroFailure {
  /** `import`, `export`, ... */
  op: string;
  /** Size of the update or snapshot that was being imported. */
  bytes?: number;
  /** Ops in the doc after the failure, when the doc still answers. */
  ops?: number;
}

const FAILURE_KEY = 'loroFailure';

/**
 * Run a call into loro-wasm. When it throws, the error gets a hidden
 * {@link LoroFailure} and is rethrown as it was. A wasm panic reaches us as a
 * bare `RuntimeError: unreachable` that says nothing about what was running.
 */
export function loroCall<T>(
  op: string,
  doc: LoroDoc | undefined,
  run: () => T,
  bytes?: number,
): T {
  try {
    return run();
  } catch (error) {
    noteLoroFailure(error, op, doc, bytes);
    throw error;
  }
}

function noteLoroFailure(
  error: unknown,
  op: string,
  doc: LoroDoc | undefined,
  bytes: number | undefined,
): void {
  // The innermost call knows best; Loro also throws plain strings, which
  // cannot carry a note.
  if (typeof error !== 'object' || error === null || FAILURE_KEY in error)
    return;

  const failure: LoroFailure = { op };

  if (bytes !== undefined) failure.bytes = bytes;

  try {
    // A trapped wasm instance may not answer, or may trap again.
    failure.ops = doc?.opCount();
  } catch {
    // Leave it out.
  }

  try {
    // Not enumerable: it must not end up in a serialized copy of the error.
    Object.defineProperty(error, FAILURE_KEY, { value: failure });
  } catch {
    // A frozen error stays unannotated.
  }
}

/** The note {@link loroCall} left on an error, or on its `cause` chain. */
export function getLoroFailure(error: unknown): LoroFailure | undefined {
  for (
    let depth = 0;
    depth < 4 && typeof error === 'object' && error;
    depth++
  ) {
    const failure = (error as { [FAILURE_KEY]?: LoroFailure })[FAILURE_KEY];

    if (failure) return failure;

    error = (error as { cause?: unknown }).cause;
  }

  return undefined;
}
