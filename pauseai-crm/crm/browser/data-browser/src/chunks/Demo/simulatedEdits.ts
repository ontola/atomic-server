// React Compiler: plain helpers, not components (see DemoDirector.ts).
'use no memo';
import {
  enableLoro,
  LoroLoader,
  type Resource,
  type Store,
} from '@tomic/react';
import type { LoroDoc, LoroMap } from 'loro-crdt';

/**
 * Persona edits are simulated remote clients: mutate a detached copy
 * ("fork") of the resource's Loro doc, then feed the resulting delta
 * through `store.applyIncoming` — byte-identical to a real teammate's
 * edit arriving over the websocket. This keeps persona ops off the
 * user's undo stack (they're remote imports, not local ops) and out of
 * the outbox (the demo drive is local-only; imports never mark dirty).
 */

/** Detached copy of the resource's Loro doc, ready to mutate as a peer. */
export async function forkResourceDoc(resource: Resource): Promise<LoroDoc> {
  await enableLoro();

  const main = resource.getLoroDoc();

  if (!main) {
    throw new Error(`No Loro doc for ${resource.subject}`);
  }

  const fork = new LoroLoader.Loro.LoroDoc();
  fork.import(main.export({ mode: 'snapshot' }));

  return fork;
}

/** Pull the user's concurrent edits into the fork so the peer builds on
 *  current state (CRDT merge — order-independent). */
export function mergeMainIntoFork(resource: Resource, fork: LoroDoc): void {
  const main = resource.getLoroDoc();
  if (!main) return;

  const bytes = main.export({ mode: 'update', from: fork.oplogVersion() });

  if (bytes.length > 0) {
    fork.import(bytes);
  }
}

/** Push the fork's new ops into the real resource through the same
 *  ingress remote edits use. Persists to OPFS and notifies the UI. */
export function pushForkDelta(
  store: Store,
  resource: Resource,
  fork: LoroDoc,
): void {
  const main = resource.getLoroDoc();
  if (!main) return;

  const bytes = fork.export({ mode: 'update', from: main.oplogVersion() });

  if (bytes.length === 0) return;

  store.applyIncoming({
    subject: resource.subject,
    loroBytes: bytes,
    source: 'ws-sub-push',
    forceNotify: true,
  });
}

/**
 * One persona-authored propval edit (e.g. flipping a checklist cell).
 * The commit message carries the persona subject, the same authorship
 * channel real commits use (`getLoroHistory` reads it back).
 */
export async function simulatePropEdit(
  store: Store,
  resource: Resource,
  personaSubject: string,
  mutate: (properties: LoroMap) => void,
): Promise<void> {
  const fork = await forkResourceDoc(resource);
  mergeMainIntoFork(resource, fork);
  mutate(fork.getMap('properties') as LoroMap);
  fork.commit({ message: personaSubject, timestamp: Date.now() });
  pushForkDelta(store, resource, fork);
}
