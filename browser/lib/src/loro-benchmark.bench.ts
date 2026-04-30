import { describe, it, bench } from 'vitest';
import { enableLoro } from './loro-loader.js';
import type { LoroDoc as LoroDocType } from 'loro-crdt';

await enableLoro();

// Dynamic import since Loro needs to be loaded first
const { LoroDoc } = (await import('loro-crdt'));

describe('Loro vs Map performance', () => {
  const PROP_COUNT = 10;
  const props = Array.from({ length: PROP_COUNT }, (_, i) => [
    `https://atomicdata.dev/properties/prop${i}`,
    i % 2 === 0 ? `value-${i}` : i * 100,
  ]) as [string, string | number][];

  // Setup a plain Map
  const map = new Map<string, string | number>();

  for (const [k, v] of props) {
    map.set(k, v);
  }

  // Setup a Loro doc with same data
  const doc = new LoroDoc();
  const loroMap = doc.getMap('properties');

  for (const [k, v] of props) {
    loroMap.set(k, v);
  }

  // Benchmark: Map.get() — baseline
  bench('Map.get() x10 props', () => {
    for (const [k] of props) {
      map.get(k);
    }
  });

  // Benchmark: LoroMap.get() — the proposed replacement
  bench('LoroMap.get() x10 props', () => {
    for (const [k] of props) {
      loroMap.get(k);
    }
  });

  // Benchmark: Map.set() — baseline write
  bench('Map.set() x10 props', () => {
    for (const [k, v] of props) {
      map.set(k, v);
    }
  });

  // Benchmark: LoroMap.set() — proposed write
  bench('LoroMap.set() x10 props', () => {
    for (const [k, v] of props) {
      loroMap.set(k, v);
    }
  });

  // Benchmark: creating 200 Loro docs (sidebar scenario)
  bench('Create 200 LoroDoc + populate 10 props each', () => {
    for (let i = 0; i < 200; i++) {
      const d = new LoroDoc();
      const m = d.getMap('properties');

      for (const [k, v] of props) {
        m.set(k, v);
      }
    }
  });

  // Benchmark: importing 200 snapshots (page reload scenario)
  const snapshot = doc.export({ mode: 'snapshot' });

  bench('Import 200 snapshots (page reload)', () => {
    for (let i = 0; i < 200; i++) {
      const d = new LoroDoc();
      d.import(snapshot);
    }
  });

  // Benchmark: reading all props from 200 docs
  const docs: LoroDocType[] = [];

  for (let i = 0; i < 200; i++) {
    const d = new LoroDoc();
    d.import(snapshot);
    docs.push(d);
  }

  bench('Read 10 props from 200 docs (render cycle)', () => {
    for (const d of docs) {
      const m = d.getMap('properties');

      for (const [k] of props) {
        m.get(k);
      }
    }
  });

  // Baseline: same with Maps
  const maps: Map<string, string | number>[] = [];

  for (let i = 0; i < 200; i++) {
    const m = new Map(props);
    maps.push(m);
  }

  bench('Read 10 props from 200 Maps (render cycle baseline)', () => {
    for (const m of maps) {
      for (const [k] of props) {
        m.get(k);
      }
    }
  });

  // Benchmark: toJSON() cost (called once per write, not per read)
  bench('LoroMap.toJSON() once', () => {
    loroMap.toJSON();
  });

  // Read from a cached toJSON object (plain object property access)
  const cached = loroMap.toJSON() as Record<string, unknown>;

  bench('Read 10 props from cached toJSON object', () => {
    for (const [k] of props) {
      cached[k];
    }
  });

  // toJSON() for 200 docs (worst case: bulk import triggers 200 cache rebuilds)
  bench('toJSON() for 200 docs (bulk cache rebuild)', () => {
    for (const d of docs) {
      d.getMap('properties').toJSON();
    }
  });

  // The proposed approach: read from 200 cached plain objects
  const cachedObjects = docs.map(d => d.getMap('properties').toJSON() as Record<string, unknown>);

  bench('Read 10 props from 200 cached objects (proposed)', () => {
    for (const obj of cachedObjects) {
      for (const [k] of props) {
        obj[k];
      }
    }
  });

  // Size comparison
  it('Size: Loro snapshot vs JSON-AD', () => {
    // Loro snapshot
    const loroSnapshot = doc.export({ mode: 'snapshot' });

    // JSON-AD equivalent
    const jsonAd: Record<string, unknown> = { '@id': 'https://example.com/resource' };
    for (const [k, v] of props) {
      jsonAd[k] = v;
    }
    const jsonAdStr = JSON.stringify(jsonAd);
    const jsonAdBytes = new TextEncoder().encode(jsonAdStr);

    console.log(`\n  Size comparison (${PROP_COUNT} properties):`);
    console.log(`    Loro snapshot:  ${loroSnapshot.byteLength} bytes`);
    console.log(`    JSON-AD string: ${jsonAdBytes.byteLength} bytes`);
    console.log(`    Ratio:          ${(loroSnapshot.byteLength / jsonAdBytes.byteLength).toFixed(1)}x`);

    // Also test with a more realistic resource (longer values, arrays)
    const realisticDoc = new LoroDoc();
    const rm = realisticDoc.getMap('properties');
    rm.set('https://atomicdata.dev/properties/name', 'My important document');
    rm.set('https://atomicdata.dev/properties/description', 'This is a longer description that contains more text to simulate real content in a resource.');
    rm.set('https://atomicdata.dev/properties/parent', 'did:ad:8ZEtla9eiLhfcPQQq42se35kyScsiUtvBMXdqqXrAubs8ReINwLkgx6M5LsSyGQoT/WrARH3NMxaneKKZ2iJCA==');
    rm.set('https://atomicdata.dev/properties/isA', JSON.stringify(['https://atomicdata.dev/classes/Document']));
    rm.set('https://atomicdata.dev/properties/createdAt', Date.now());
    rm.set('https://atomicdata.dev/properties/lastCommit', 'did:ad:commit:abc123def456');
    rm.set('https://atomicdata.dev/properties/write', JSON.stringify(['did:ad:agent:xyz']));
    rm.set('https://atomicdata.dev/properties/read', JSON.stringify(['did:ad:agent:xyz', 'https://atomicdata.dev/agents/publicAgent']));

    const realisticSnapshot = realisticDoc.export({ mode: 'snapshot' });
    const realisticJson = JSON.stringify({
      '@id': 'did:ad:someresource',
      'https://atomicdata.dev/properties/name': 'My important document',
      'https://atomicdata.dev/properties/description': 'This is a longer description that contains more text to simulate real content in a resource.',
      'https://atomicdata.dev/properties/parent': 'did:ad:8ZEtla9eiLhfcPQQq42se35kyScsiUtvBMXdqqXrAubs8ReINwLkgx6M5LsSyGQoT/WrARH3NMxaneKKZ2iJCA==',
      'https://atomicdata.dev/properties/isA': ['https://atomicdata.dev/classes/Document'],
      'https://atomicdata.dev/properties/createdAt': Date.now(),
      'https://atomicdata.dev/properties/lastCommit': 'did:ad:commit:abc123def456',
      'https://atomicdata.dev/properties/write': ['did:ad:agent:xyz'],
      'https://atomicdata.dev/properties/read': ['did:ad:agent:xyz', 'https://atomicdata.dev/agents/publicAgent'],
    });
    const realisticJsonBytes = new TextEncoder().encode(realisticJson);

    console.log(`\n  Realistic resource (8 properties):`);
    console.log(`    Loro snapshot:  ${realisticSnapshot.byteLength} bytes`);
    console.log(`    JSON-AD string: ${realisticJsonBytes.byteLength} bytes`);
    console.log(`    Ratio:          ${(realisticSnapshot.byteLength / realisticJsonBytes.byteLength).toFixed(1)}x`);

    // After 10 edits to the name
    for (let i = 0; i < 10; i++) {
      rm.set('https://atomicdata.dev/properties/name', `My important document (edit ${i + 1})`);
    }
    const afterEditsSnapshot = realisticDoc.export({ mode: 'snapshot' });
    console.log(`\n  After 10 edits to name:`);
    console.log(`    Loro snapshot:  ${afterEditsSnapshot.byteLength} bytes`);
    console.log(`    Growth:         +${afterEditsSnapshot.byteLength - realisticSnapshot.byteLength} bytes from edits`);

    // After 100 edits
    for (let i = 10; i < 100; i++) {
      rm.set('https://atomicdata.dev/properties/name', `My important document (edit ${i + 1})`);
    }
    const after100EditsSnapshot = realisticDoc.export({ mode: 'snapshot' });
    console.log(`\n  After 100 edits to name:`);
    console.log(`    Loro snapshot:  ${after100EditsSnapshot.byteLength} bytes`);
    console.log(`    JSON-AD:        ${realisticJsonBytes.byteLength} bytes (unchanged)`);
    console.log(`    Ratio:          ${(after100EditsSnapshot.byteLength / realisticJsonBytes.byteLength).toFixed(1)}x`);
  });
});
