import { describe, expect, it } from 'vitest';
import { core, dataBrowser } from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import { ensureSyncablePlatform, platformLocalId } from './syncablePlatform';

describe('platformLocalId', () => {
  it('is scoped to the configured proxy and stable across display names', () => {
    expect(platformLocalId('https://proxy.example', 'github-issues')).toBe(
      platformLocalId('https://proxy.example', 'github-issues'),
    );
    expect(platformLocalId('https://proxy.example', 'github-issues')).not.toBe(
      platformLocalId('https://other.example', 'github-issues'),
    );
    expect(() => platformLocalId('https://proxy.example/path', 'github-issues')).toThrow(
      'must be an origin',
    );
    expect(() => platformLocalId('https://proxy.example', '../unsafe')).toThrow(
      'Invalid integration platform ID',
    );
  });
});

describe('ensureSyncablePlatform', () => {
  it('creates one ordinary root-level table and reuses it on reinstall', async () => {
    const { store, resources } = fakeSchemaStore();
    const options = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };

    const first = await ensureSyncablePlatform(store, options);
    const second = await ensureSyncablePlatform(store, {
      ...options,
      name: 'Renamed GitHub',
    });

    expect(second).toBe(first);
    const props = resources.get(first);
    expect(props?.[core.properties.parent]).toBe('drive');
    expect(props?.[core.properties.name]).toBe('GitHub');
    expect(props?.[core.properties.isA]).toContain(dataBrowser.classes.table);
    expect(typeof props?.[core.properties.classtype]).toBe('string');
    expect(props?.[core.properties.localId]).toBe(
      platformLocalId(options.proxyOrigin, options.platform),
    );
  });

  it('keeps installations from different proxy origins distinct', async () => {
    const { store } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const a = await ensureSyncablePlatform(store, {
      ...input,
      proxyOrigin: 'https://a.example',
    });
    const b = await ensureSyncablePlatform(store, {
      ...input,
      proxyOrigin: 'https://b.example',
    });
    expect(a).not.toBe(b);
  });
});
