import { describe, expect, it } from 'vitest';
import {
  PersistenceEvidenceRegistry,
  persistenceVersionCovers,
  persistenceCopyComplete,
} from './persistence-evidence.js';

describe('shared persistence evidence', () => {
  it('separates acceptance from storage and requires a named barrier', () => {
    const scope = new PersistenceEvidenceRegistry().open('server');
    scope.record('item', 'accepted', { version: { '1': 2 } });
    scope.record('item', 'stored', { version: { '1': 2 } });
    expect(scope.covering('item', 'accepted', { '1': 2 })).toBeDefined();
    expect(scope.covering('item', 'stored', { '1': 2 })).toBeUndefined();
    scope.record('item', 'stored', {
      version: { '1': 2 },
      barrier: 'redb-flush',
    });
    expect(scope.covering('item', 'stored', { '1': 2 })).toBeDefined();
    expect(scope.covering('item', 'stored', { '1': 3 })).toBeUndefined();
    expect(scope.covering('other', 'stored', { '1': 2 })).toBeUndefined();
  });
  it('fences replaced scopes and retains immutable captured versions', () => {
    const registry = new PersistenceEvidenceRegistry();
    const old = registry.open('vault');
    const version = { '1': 2 };
    old.record('item', 'stored', { version, barrier: 'checkpoint' });
    version['1'] = 3;
    expect(old.covering('item', 'stored', version)).toBeUndefined();
    const next = registry.open('vault');
    old.record('item', 'stored', { version, barrier: 'checkpoint' });
    expect(next.latest('item', 'stored')).toBeUndefined();
    expect(old.latest('item', 'stored')).toBeUndefined();
  });
  it('never combines partial observations into a fictitious complete version', () => {
    const scope = new PersistenceEvidenceRegistry().open('peer');
    for (const version of [{ '1': 2 }, { '2': 2 }])
      scope.record('item', 'stored', { version, barrier: 'flush' });
    expect(
      scope.covering('item', 'stored', { '1': 2, '2': 2 }),
    ).toBeUndefined();
    scope.record('item', 'stored', {
      version: { '1': 2, '2': 2 },
      barrier: 'flush',
    });
    expect(scope.receipts('item', 'stored')).toHaveLength(1);
    expect(scope.covering('item', 'stored', { '1': 1 })).toBeDefined();
  });
  it('requires contents on the same storage incarnation as the metadata', () => {
    const expected = { storageId: 'store-a', generation: 'one' };
    expect(
      persistenceCopyComplete(
        'confirmed',
        true,
        'confirmed',
        expected,
        expected,
      ),
    ).toBe(true);
    expect(
      persistenceCopyComplete('confirmed', true, 'confirmed', expected, {
        ...expected,
        generation: 'two',
      }),
    ).toBe(false);
    expect(
      persistenceCopyComplete('confirmed', true, 'confirmed', expected),
    ).toBe(false);
    expect(persistenceCopyComplete('confirmed', true, 'unknown')).toBe(false);
    expect(persistenceCopyComplete('unknown', false)).toBe(false);
  });
  it('copies manifests and clears content evidence with its scope', () => {
    const scope = new PersistenceEvidenceRegistry().open('vault');
    const manifest = {
      files: [
        {
          subject: 'atomic:file',
          hash: 'a'.repeat(64),
          chunks: [] as string[],
        },
      ],
    };
    scope.recordContents('item', { manifest, confirmedAt: 10 });
    manifest.files[0].hash = 'b'.repeat(64);
    expect(scope.content('item')?.manifest.files[0].hash).toBe('a'.repeat(64));
    scope.close();
    scope.recordContents('item', { manifest, confirmedAt: 11 });
    expect(scope.content('item')).toBeUndefined();
  });
  it('does not infer an empty or missing target is saved', () => {
    expect(persistenceVersionCovers({ '1': 1 }, {})).toBe(false);
    expect(persistenceVersionCovers(undefined, { '1': 1 })).toBe(false);
  });
});
