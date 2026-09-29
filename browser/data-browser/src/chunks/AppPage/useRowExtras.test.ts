// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { core, dataBrowser, server, type Store } from '@tomic/react';
import { appRowExtras } from './rowGrant';
import { tableRowExtras } from './useRowExtras';

const DRIVE = 'did:ad:drive';
const ONTOLOGY = 'did:ad:ontology';
const ROW_EXTRAS = 'did:ad:row-extras-property';
const SYNC_APP = 'did:ad:calendar-app';
const PLAIN_APP = 'did:ad:plain-app';
const TABLE = 'did:ad:events';
const ETAG = 'did:ad:google-etag';
const BASELINE = 'did:ad:sync-baseline';

function fakeStore(resources: Record<string, Record<string, unknown>>) {
  return {
    getResource: async (subject: string) => ({
      subject,
      get: (property: string) => resources[subject]?.[property],
    }),
  } as unknown as Store;
}

const drive = {
  [DRIVE]: { [server.properties.defaultOntology]: ONTOLOGY },
  [ONTOLOGY]: { [core.properties.properties]: [ROW_EXTRAS] },
  [ROW_EXTRAS]: { [core.properties.shortname]: 'row-extras' },
};

describe('row extras (#1849)', () => {
  it('reads what an app declares, and nothing when it declares none', async () => {
    const store = fakeStore({
      ...drive,
      [SYNC_APP]: { [ROW_EXTRAS]: [ETAG, BASELINE, ETAG] },
      [PLAIN_APP]: {},
    });

    expect(await appRowExtras(store, DRIVE, SYNC_APP)).toEqual([
      ETAG,
      BASELINE,
    ]);
    expect(await appRowExtras(store, DRIVE, PLAIN_APP)).toEqual([]);
  });

  it('is none on a drive without the plugin vocabulary', async () => {
    const store = fakeStore({ [SYNC_APP]: { [ROW_EXTRAS]: [ETAG] } });

    expect(await appRowExtras(store, DRIVE, SYNC_APP)).toEqual([]);
  });

  it("collects the extras of every app shown as one of a table's views", async () => {
    const store = fakeStore({
      ...drive,
      [SYNC_APP]: { [ROW_EXTRAS]: [ETAG, BASELINE] },
      [PLAIN_APP]: {},
      [TABLE]: {
        [dataBrowser.properties.tableViews]: [
          'did:ad:table-tab',
          'did:ad:calendar-tab',
          'did:ad:plain-tab',
        ],
      },
      'did:ad:table-tab': { [dataBrowser.properties.viewKind]: 'table' },
      'did:ad:calendar-tab': { [dataBrowser.properties.viewKind]: SYNC_APP },
      'did:ad:plain-tab': { [dataBrowser.properties.viewKind]: PLAIN_APP },
    });

    expect(await tableRowExtras(store, DRIVE, TABLE)).toEqual([ETAG, BASELINE]);
  });
});
