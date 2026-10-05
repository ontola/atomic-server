import { it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { Resource } from './resource.js';
import { LoroLoader } from './loro-loader.js';
import { core } from './ontologies/core.js';

// Opt-in reproducible hot-path probe; timings are evidence, not CI thresholds.
// SCHEMA_IMPORT_BENCH=1 pnpm exec vitest run src/schema-import.perf.test.ts
it.skipIf(process.env.SCHEMA_IMPORT_BENCH !== '1')(
  'imports small deltas into a large canvas',
  () => {
    const source = new Resource('atomic:large-canvas-benchmark');
    const doc = source.getLoroDoc()!;
    const strokes = doc
      .getMap('properties')
      .setContainer(
        'https://example.test/strokes',
        new LoroLoader.Loro.LoroList(),
      );
    for (let i = 0; i < 10000; i++)
      strokes.push({
        id: i,
        points: Array.from({ length: 64 }, (_, j) => (i + j) % 1000),
      });
    const snapshot = doc.export({ mode: 'snapshot' });
    const target = new Resource(source.subject);
    expect(target.importLoroUpdate(snapshot).complete).toBe(true);
    const samples: number[] = [];

    for (let i = 0; i < 35; i++) {
      const from = doc.version();
      doc.getMap('properties').set(core.properties.name, `Canvas ${i}`);
      const delta = doc.export({ mode: 'update', from });
      from.free();
      const start = performance.now();
      expect(target.importLoroUpdate(delta).complete).toBe(true);
      if (i >= 5) samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    process.stdout.write(
      'SCHEMA_IMPORT_BENCH ' +
        JSON.stringify({
          strokes: 10000,
          coordinates: 640000,
          snapshotBytes: snapshot.length,
          samples: samples.length,
          medianMs: samples[15],
          p95Ms: samples[28],
          maxMs: samples[29],
        }) +
        '\n',
    );
    expect(target.get(core.properties.name)).toBe('Canvas 34');
  },
);
