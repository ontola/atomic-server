/**
 * Live half of `src/loro-compat.test.ts`: fresh bytes, not fixtures, crossing
 * between loro-crdt (the tab) and the Rust `loro` inside atomic-wasm (the
 * client-DB worker), through the same ClientDb calls the worker serves.
 * Needs a built `wasm/pkg` (see wasm-node-smoke).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoroDoc, LoroList } from 'loro-crdt';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeClientDb } from '../src/client-db.node.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../wasm/pkg/atomic_wasm_bg.wasm');
const origin = 'http://localhost:9883';
const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const IS_A = 'https://atomicdata.dev/properties/isA';

let db: NodeClientDb | undefined;

/** The worker keys its own origin's subjects in `internal:` form. */
function storageKey(subject: string): string {
  return subject.replace(origin, 'internal:');
}

async function openDb(): Promise<NodeClientDb> {
  db = new NodeClientDb({ wasmPath });
  await db.init(origin);

  return db;
}

afterEach(() => {
  db?.destroy();
  db = undefined;
});

describe('Loro bytes crossing the tab / worker boundary', () => {
  it('the tab reads the snapshot the worker builds from JSON-AD', async () => {
    const worker = await openDb();
    const subject = `${origin}/loro-compat-worker-written`;
    await worker.putResource(
      JSON.stringify({
        '@id': subject,
        [NAME]: 'Built by the worker',
        [DESCRIPTION]: 'Some *markdown*',
        [IS_A]: ['https://atomicdata.dev/classes/Document'],
      }),
    );

    const snapshot = await worker.getLoroSnapshot(subject);
    expect(snapshot).not.toBeNull();

    const doc = new LoroDoc();
    doc.import(snapshot!);
    const props = doc.getMap('properties').toJSON();
    expect(props[NAME]).toBe('Built by the worker');
    expect(props[DESCRIPTION]).toBe('Some *markdown*');
    expect(props[IS_A]).toEqual(['https://atomicdata.dev/classes/Document']);

    const vvs = await worker.getAllVersionVectors();
    const tabVv = Object.fromEntries(
      [...doc.oplogVersion().toJSON()].map(([p, c]) => [String(p), c]),
    );
    expect(vvs[storageKey(subject)]).toEqual(tabVv);
  });

  it('the worker reads the version of a snapshot the tab wrote', async () => {
    const worker = await openDb();
    const subject = `${origin}/loro-compat-tab-written`;

    const doc = new LoroDoc();
    doc.setRecordTimestamp(true);
    doc.getMap('properties').set(NAME, 'Written by the tab');
    doc
      .getMap('properties')
      .setContainer(IS_A, new LoroList())
      .push('https://atomicdata.dev/classes/Document');
    doc.getMap('datatypes').set(IS_A, 'resourceArray');
    doc.commit({ timestamp: Date.now(), message: 'did:ad:agent:tab' });
    doc.getMap('properties').set(NAME, 'Edited by the tab');
    doc.commit({ timestamp: Date.now() });

    const snapshot = doc.export({ mode: 'snapshot' });
    await worker.putResourceWithSnapshot(
      subject,
      JSON.stringify({ '@id': subject, [NAME]: 'Edited by the tab' }),
      snapshot,
    );

    const vvs = await worker.getAllVersionVectors();
    const tabVv = Object.fromEntries(
      [...doc.oplogVersion().toJSON()].map(([p, c]) => [String(p), c]),
    );
    expect(vvs[storageKey(subject)]).toEqual(tabVv);

    // Round trip: what the worker hands back imports to the same state.
    const back = new LoroDoc();
    back.import((await worker.getLoroSnapshot(subject))!);
    expect(back.toJSON()).toEqual(doc.toJSON());
  });
});
