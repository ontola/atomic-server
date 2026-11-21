import type { AtomicValue, Resource } from '@tomic/react';

/** Puts a property back to the value it had before it was edited. */
export function discardEdit(
  resource: Resource,
  property: string,
  initialValue: AtomicValue | undefined,
): void {
  if (JSON.stringify(resource.get(property)) === JSON.stringify(initialValue)) {
    return;
  }

  if (initialValue === undefined) {
    resource.remove(property);

    return;
  }

  void resource.set(property, initialValue, false).catch(() => undefined);
}
