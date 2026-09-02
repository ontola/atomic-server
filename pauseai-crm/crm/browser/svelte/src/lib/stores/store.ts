import { getContext, setContext } from 'svelte';
import type { Store } from '@tomic/lib';

export const ATOMIC_STORE_CONTEXT_KEY = 'ATOMIC_STORE';

export function createAtomicStoreContext(store: Store): void {
  setContext(ATOMIC_STORE_CONTEXT_KEY, store);
}

export function getStoreFromContext(): Store {
  return getContext(ATOMIC_STORE_CONTEXT_KEY);
}
