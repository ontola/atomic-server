// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import type { PluginRoutesStatus } from '@tomic/react';
import { gateCatalog } from './catalogGate';

const plain = { name: 'plain', requires: ['wasm-sandbox'] };
const legacy = { name: 'legacy', requires: null };
const readOnly = {
  name: 'read-only',
  requires: ['plugin-routes:read-only', 'public-origin', 'wasm-sandbox'],
};
const readWrite = {
  name: 'read-write',
  requires: ['plugin-routes:read-write', 'public-origin', 'wasm-sandbox'],
};
const listener = {
  name: 'listener',
  requires: ['operator-listener:willow-wgps', 'plugin-routes:read-write'],
};
const entries = [plain, legacy, readOnly, readWrite, listener];

const node = (
  compiled: boolean,
  level: PluginRoutesStatus['level'],
  listeners: string[] = [],
): PluginRoutesStatus => ({
  compiled,
  level,
  routesOrigin: null,
  listeners,
  sidecars: [],
});

const names = (result: ReturnType<typeof gateCatalog<(typeof entries)[0]>>) =>
  result.shown.map(({ entry, refusal }) =>
    refusal ? `${entry.name} (marked)` : entry.name,
  );

describe('gateCatalog', () => {
  it('hides gated plugins when the build has no plugin routes', () => {
    const result = gateCatalog(entries, node(false, 'off'));

    expect(names(result)).toEqual(['plain', 'legacy']);
    expect(result.hidden).toBe(3);
  });

  it('hides them on a server from before the gates', () => {
    expect(gateCatalog(entries, undefined).hidden).toBe(3);
  });

  it('marks them when the level is too low', () => {
    const result = gateCatalog(entries, node(true, 'read-only'));

    expect(names(result)).toEqual([
      'plain',
      'legacy',
      'read-only',
      'read-write (marked)',
      'listener (marked)',
    ]);
    expect(result.hidden).toBe(0);
    expect(result.shown[3].refusal).toMatchObject({
      compiled: true,
      level: 'read-only',
      needed: 'read-write',
    });
  });

  it('marks one whose listener the operator has not bound', () => {
    const result = gateCatalog(entries, node(true, 'read-write'));

    expect(names(result)).toEqual([
      'plain',
      'legacy',
      'read-only',
      'read-write',
      'listener (marked)',
    ]);
    expect(result.shown[4].refusal?.listeners).toEqual(['willow-wgps']);
  });

  it('lists everything normally when the gates are open', () => {
    const result = gateCatalog(
      entries,
      node(true, 'read-write', ['willow-wgps']),
    );

    expect(names(result)).toEqual(entries.map(e => e.name));
  });
});
