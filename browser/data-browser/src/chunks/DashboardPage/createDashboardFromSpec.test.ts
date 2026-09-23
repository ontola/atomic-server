// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { core, dataBrowser, type Resource, type Store } from '@tomic/lib';
import { buildDashboardFromSpec } from './createDashboardFromSpec';

describe('composed View authoring', () => {
  it('creates one View as the block root for an Assistant composition', async () => {
    const resource = {
      subject: 'composed-view',
      save: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
    } as unknown as Resource;
    const store = {
      newResource: vi.fn(async () => resource),
    } as unknown as Store;

    const result = await buildDashboardFromSpec(
      store,
      { name: 'Overview', blocks: [] },
      { parent: 'drive' },
    );

    expect(store.newResource).toHaveBeenCalledWith({
      parent: 'drive',
      isA: dataBrowser.classes.view,
      propVals: {
        [core.properties.name]: 'Overview',
        [dataBrowser.properties.viewKind]: 'blocks',
      },
    });
    expect(resource.set).toHaveBeenCalledWith(
      dataBrowser.properties.dashboardBlocks,
      [],
    );
    expect(result.dashboardSubject).toBe('composed-view');
  });
});
