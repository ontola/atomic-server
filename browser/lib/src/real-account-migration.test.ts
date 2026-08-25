import { describe, it } from 'vitest';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { testStore } from './test-store.js';

/**
 * A real pre-DID account's `drives` list, taken verbatim. The account's Agent
 * lives on atomicdata.dev; the client signing in is a desktop node on
 * localhost, which is the situation the whole legacy path exists for and the
 * one where it used to adopt nothing at all.
 */
const REAL_LEGACY_DRIVES = [
  'https://atomicdata.dev/drive/xzpv34r5ibr',
  'https://atomicdata.dev/drive/uiwpr85ie5',
  'https://staging.atomicdata.dev/drive/ckggjb1d3md',
  'https://atomicdata.dev/drive/wd22yxmxw4j',
  'https://staging.atomicdata.dev/drive/hu3zyo48hrk',
  'https://atomicdata.dev/drive/yf0pzh8v8f',
  'https://atomicdata.dev/drive/92yq9rh8tto',
  'https://atomicdata.dev/drive/x7tkn0udybl',
  'https://atomicdata.dev/drive/7eqsy7w84eo',
  'https://atomicdata.dev/drive/tlqc9jtz5oj',
  'https://atomicdata.dev/drive/dxbdhd48i9r',
  'https://staging.atomicdata.dev/drive/o6kr36n355g',
  'https://staging.atomicdata.dev/drive/41w8ah24nx',
  'https://atomicdata.dev/drive/hms3fnoue08',
  'https://atomicdata.dev/drive/g9fuuv7qcej',
  'https://atomicdata.dev/drive/9k62ef0eldg',
  'https://atomicdata.dev/drive/xpectln6zf',
  'https://atomicdata.dev/drive/xguajxank6b',
  'https://atomicdata.dev/drive/ehznq6mz7vm',
  'https://atomicdata.dev/drive/8by8zw4olv2',
  'https://atomicdata.dev/drive/9wtmc8uk1il',
  'https://atomicdata.dev/drive/9u3s8h3dp89',
  'https://atomicdata.dev/drive/xacbwbumnkd',
  'https://atomicdata.dev/drive/c4us75xed3o',
  'https://atomicdata.dev/drive/fw18lanhoi7',
  'https://atomicdata.dev/drive/ubvghassjtn',
  'https://atomicdata.dev/drive/vbjfy176h4',
  'https://staging.atomicdata.dev/drive/5up73z98e0p',
  'https://staging.atomicdata.dev/drive/zeg5rq7lz4d',
  'https://staging.atomicdata.dev/drive/KrOMdgvZ',
  'https://staging.atomicdata.dev/drive/ggNbDEd5',
  'https://staging.atomicdata.dev/drive/wlU0ptWe',
  'https://staging.atomicdata.dev/drive/nRQpoN51',
  'https://atomicdata.dev/drive/0PXBdxdX',
  'https://atomicdata.dev/drive/e1wEOaJv',
  'https://staging.atomicdata.dev/01hw5n6kxbpa3j9hpgy7h6z94x',
  'https://staging.atomicdata.dev/drive/DbYX0DLO',
  'http://dawdawda.localhost:9883/01j3fqv30nqa0nevd3rnjnrsse',
  'http://dawdawda.localhost:9883/01j44gjrm4tm8fjx3cvfv7edes',
  'https://staging.atomicdata.dev/01j52zyrw2ca3rm6v1wvkvy8k2',
  'http://localhost:9883/01j71grbnyq2w922g2ttt7w46e',
  'https://staging.atomicdata.dev/drive/GMQMKO1C',
  'http://localhost:9883/01j9h0q1664ypfjr05nk0276mk',
  'http://localhost:9883/01j9nkgzrfa3bh9zyqb2j6z8c4',
  'https://staging.atomicdata.dev/drive/fbNcKEt0',
  'https://atomicdata.dev/drive/hTPiNoiY',
  'https://atomicdata.dev/01jbf1try7vyh1xrtbvdt6ez78',
  'http://localhost:9883/01jv2aqzqc1g1wpq4ywpfxq89n',
  'http://localhost:9883/01jvpst7jqw4j462e9c51gctcw',
  'http://localhost:9883/01jy16kjbvqam7xtg1b5scxtxz',
  'http://localhost:9883/01jy1rx81v2scdb7ejgjcnvm5f',
  'http://localhost:9883/01jykhqdbx4p949tyd83hecnqg',
  'http://localhost:9883/01kgqcsm59zjhc83fajcxkxpz6',
];

const LEGACY_AGENT = 'https://atomicdata.dev/agents/QmExample=';

describe('migrating a real pre-DID account', () => {
  it('adopts the account origin and nothing else', async ({ expect }) => {
    const { store, agentDID } = await testStore();
    const agent = store.getAgent()!;

    agent.legacySubject = LEGACY_AGENT;

    const legacy = store.getResourceLoading(LEGACY_AGENT, {
      newResource: true,
    });
    await legacy.set(core.properties.isA, [core.classes.agent], false);
    await legacy.set(core.properties.name, 'joep.io', false);
    await legacy.set(server.properties.drives, REAL_LEGACY_DRIVES, false);

    const didAgent = store.getResourceLoading(agentDID, { newResource: true });
    await didAgent.set(core.properties.isA, [core.classes.agent], false);

    await (
      store as unknown as {
        adoptLegacyDriveList: (
          a: unknown,
          l: unknown,
          d: unknown,
        ) => Promise<void>;
      }
    ).adoptLegacyDriveList(agent, legacy, didAgent);

    const derived = await store.getResource(await agent.privateDriveSubject());
    const listed = derived.getSubjects(server.properties.drives);

    const from = (host: string) => listed.filter(s => s.includes(host)).length;

    // The account's own server: these are the drives worth having.
    expect(from('//atomicdata.dev/')).toBe(27);

    // A different origin from the Agent, so not covered by the account's own
    // trust. Adopting these needs an origin set, not a single origin.
    expect(from('//staging.atomicdata.dev/')).toBe(0);

    // The class `legacy-drive-adoption.test.ts` exists for: a stale entry that
    // would point a hosted app at the signed-in user's own machine.
    expect(from('localhost:9883')).toBe(0);
  });
});
