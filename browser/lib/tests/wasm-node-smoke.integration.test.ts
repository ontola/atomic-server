/**
 * Smoke test: load the `--target web` wasm/pkg directly in Node, instantiate
 * an in-memory ClientDb, and round-trip a blob. Proves the foundation that
 * the integration harness builds on.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { LoroDoc, LoroList } from 'loro-crdt';

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

  it('stores a snapshot as given and reads it back with the row', async () => {
    const db = new NodeClientDb({ wasmPath });
    await db.init('http://localhost:9883');
    const subject = 'http://localhost:9883/smoke-snapshot';
    const name = 'https://atomicdata.dev/properties/name';
    const doc = new LoroDoc();
    doc.getMap('props').set(name, 'from the tab');
    const snapshot = doc.export({ mode: 'snapshot' });

    await db.putResourceWithSnapshot(
      subject,
      JSON.stringify({ '@id': subject, [name]: 'from the tab' }),
      snapshot,
    );
    const row = await db.getResourceWithSnapshot(subject);

    expect(Array.from(row.snapshot ?? [])).toEqual(Array.from(snapshot));
    const json = JSON.parse(row.jsonAd!);
    expect(json[name]).toBe('from the tab');
    // The snapshot travels beside the row, not a second time inside it.
    expect(
      json['https://atomicdata.dev/properties/loroUpdate'],
    ).toBeUndefined();

    db.destroy();
  });

  it('keeps properties it cannot resolve, and empty arrays, in the row', async () => {
    const db = new NodeClientDb({ wasmPath });
    await db.init('http://localhost:9883');
    const subject = 'http://localhost:9883/smoke-unresolvable';
    const name = 'https://atomicdata.dev/properties/name';
    const requires = 'https://atomicdata.dev/properties/requires';
    // Schema terms of a drive this database holds no definition for.
    const unknown = 'atomic:propUNKNOWNsmoke';
    const emptied = 'atomic:propEMPTIEDsmoke';
    const doc = new LoroDoc();
    const props = doc.getMap('properties');
    props.set(name, 'automation');
    props.setContainer(requires, new LoroList());
    props.setContainer(unknown, new LoroList());
    props.setContainer(emptied, new LoroList()).push('https://example.com/a');
    doc.commit();
    (props.get(emptied) as LoroList).delete(0, 1);
    doc.commit();
    const snapshot = doc.export({ mode: 'snapshot' });

    await db.putResourceWithSnapshot(
      subject,
      JSON.stringify({
        '@id': subject,
        [name]: 'automation',
        [requires]: [],
        [unknown]: [],
        [emptied]: [],
      }),
      snapshot,
    );
    const json = JSON.parse(
      (await db.getResourceWithSnapshot(subject)).jsonAd!,
    );

    expect(json[name]).toBe('automation');
    expect(json[requires]).toEqual([]);
    expect(json[unknown]).toEqual([]);
    expect(json[emptied]).toEqual([]);

    db.destroy();
  });
});
