/**
 * Smoke test: load the `--target web` wasm/pkg directly in Node, instantiate
 * an in-memory ClientDb, and round-trip a blob. Proves the foundation that
 * the integration harness builds on.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import init, { ClientDb } from '../../../wasm/pkg/atomic_wasm.js';
import { NodeClientDb } from '../src/client-db.node.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../wasm/pkg/atomic_wasm_bg.wasm');

describe('wasm/pkg in Node', () => {
  it('loads and round-trips a blob via in-memory ClientDb', async () => {
    const bytes = await readFile(wasmPath);
    await init({ module_or_path: bytes });

    const db = await ClientDb.newInMemory(undefined);
    await db.populate();

    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const hash = db.blake3Hash(data);
    expect(hash).toHaveLength(32);

    db.putBlob(hash, data);
    const round = db.getBlob(hash) as Uint8Array | null;

    expect(round).not.toBeNull();
    expect(Array.from(round!)).toEqual(Array.from(data));
  });

  it('NodeClientDb adapter exposes the same surface', async () => {
    const db = new NodeClientDb({ wasmPath });
    await db.init('http://localhost:9883');

    expect(db.isReady).toBe(true);

    const data = new Uint8Array([42, 7, 9, 11]);
    const hash = await db.blake3Hash(data);
    expect(hash).toHaveLength(32);

    await db.putBlob(hash, data);
    const round = await db.getBlob(hash);
    expect(round).not.toBeNull();
    expect(Array.from(round!)).toEqual(Array.from(data));

    db.destroy();
  });
});
