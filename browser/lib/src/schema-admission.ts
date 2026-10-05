import type { LoroDoc } from 'loro-crdt';
import type { Resource } from './resource.js';
import { LoroLoader } from './loro-loader.js';
import {
  resolveSchemaDependencies,
  validateSchemaData,
} from './schema-dependencies.js';

// At most one isolated replica, released after five idle seconds. Reusing it
// avoids cloning a large active canvas for each tiny incoming delta. It never
// replaces the live doc (subscriptions, undo and pending edits stay attached).
let replica: { base: WeakRef<LoroDoc>; doc: LoroDoc } | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;

export function clearSchemaAdmissionReplica(): void {
  if (expiry !== undefined) clearTimeout(expiry);
  expiry = undefined;
  const old = replica;
  replica = undefined;
  old?.doc.free();
}

export function validateIncomingSchema(
  base: LoroDoc | undefined,
  bytes: Uint8Array,
  lookup: (id: string) => Resource | undefined,
): { complete: boolean; definitions: Map<string, Resource> } {
  // Caller seals pending edits before this function: Loro export/fork can
  // auto-commit, so a history token must already have been attached.
  try {
    if (
      replica &&
      replica.base.deref() === base &&
      base &&
      !base.isDetached()
    ) {
      const current = base.oplogVersion();
      const staged = replica.doc.oplogVersion();

      try {
        const order = current.compare(staged);

        if (order === undefined || order < 0) {
          // The preceding live import failed, or state was rolled back. Never
          // let unadmitted operations from the replica affect a later check.
          clearSchemaAdmissionReplica();
        } else if (order > 0) {
          const status = replica.doc.import(
            base.export({ mode: 'update', from: staged }),
          );
          if (status.pending?.size) clearSchemaAdmissionReplica();
        }
      } finally {
        current.free();
        staged.free();
      }
    } else {
      clearSchemaAdmissionReplica();
    }

    const doc = replica?.doc ?? base?.fork() ?? new LoroLoader.Loro.LoroDoc();
    if (base) replica = { base: new WeakRef(base), doc };

    try {
      const status = doc.import(bytes);

      if (status.pending?.size) {
        clearSchemaAdmissionReplica();

        return { complete: false, definitions: new Map() };
      }

      const definitions = resolveSchemaDependencies(doc, lookup);
      validateSchemaData(doc, definitions);

      if (base) {
        if (expiry !== undefined) clearTimeout(expiry);
        expiry = setTimeout(clearSchemaAdmissionReplica, 5000);
      }

      return { complete: true, definitions };
    } finally {
      if (!base) doc.free();
    }
  } catch (error) {
    clearSchemaAdmissionReplica();
    throw error;
  }
}
