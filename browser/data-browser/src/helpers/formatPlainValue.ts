import type { AtomicValue } from '@tomic/react';

/** Values like JSON objects can't be React children, so they're written out as text. */
export function formatPlainValue(val: AtomicValue): string {
  if (val === null || val === undefined) {
    return '';
  }

  if (typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch {
      return '';
    }
  }

  return String(val);
}
