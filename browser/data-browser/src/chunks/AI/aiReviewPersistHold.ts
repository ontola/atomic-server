import type { Store } from '@tomic/react';

const heldSubjectsByStore = new WeakMap<Store, Set<string>>();
const patchedMarkDirty = new WeakSet<Store>();

function getHeldSet(store: Store): Set<string> {
  let set = heldSubjectsByStore.get(store);

  if (!set) {
    set = new Set();
    heldSubjectsByStore.set(store, set);
  }

  return set;
}

/** Wrap `outbox.markDirty` so unconfirmed AI edits are not queued for drain. */
export function ensureAIReviewPersistHoldInstalled(store: Store): void {
  if (patchedMarkDirty.has(store)) return;

  const held = getHeldSet(store);
  const outbox = store.outbox;
  const originalMarkDirty = outbox.markDirty.bind(outbox);

  outbox.markDirty = (subject: string) => {
    if (held.has(subject)) return;
    originalMarkDirty(subject);
  };

  patchedMarkDirty.add(store);
}

export function holdAIReviewEdits(store: Store, subject: string): void {
  ensureAIReviewPersistHoldInstalled(store);
  getHeldSet(store).add(subject);
  store.outbox.clearDirty(subject);
}

export function releaseAIReviewEdits(store: Store, subject: string): void {
  getHeldSet(store).delete(subject);
}

export function isAIReviewHeld(store: Store, subject: string): boolean {
  return getHeldSet(store).has(subject);
}
