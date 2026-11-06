// @wc-ignore-file
import { decodeB64, encodeB64, LoroLoader } from '@tomic/lib';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as Loro from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { createMockHost, MEMORY_HOST_PREFIX } from './mockHost';

// Node, for the signing keys. Loro resolves to its browser build here, which
// waits for its WASM: given from the package, and handed to the loader.
const wasm = readFileSync(
  createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
);
await (
  Loro as unknown as { default: (o: { module_or_path: Buffer }) => unknown }
).default({ module_or_path: wasm });
(LoroLoader as unknown as { _Loro: unknown })._Loro = Loro;

/** A Storage in memory, like a tab's sessionStorage. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();

  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const SUBJECT = 'did:ad:test:1';
const NAME = 'https://atomicdata.dev/properties/name';
const IS_A = 'https://atomicdata.dev/properties/isA';
const DOCUMENT_V2 = 'https://atomicdata.dev/classes/DocumentV2';

describe('the memory host (?host=memory)', () => {
  it('serves a resource the page that shows the editor put there', async () => {
    const storage = memoryStorage();
    storage.setItem(
      MEMORY_HOST_PREFIX + SUBJECT,
      JSON.stringify({ jsonAd: { [NAME]: 'Motie' }, snapshot: null }),
    );
    const host = createMockHost(storage);
    const json = JSON.parse(
      (await host.call('getResource', [SUBJECT])) as string,
    );

    expect(json['@id']).toBe(SUBJECT);
    expect(json[NAME]).toBe('Motie');
  });

  it('keeps the Loro updates of commits for the next page', async () => {
    const storage = memoryStorage();
    const first = createMockHost(storage);
    await first.call('putResource', [
      JSON.stringify({ '@id': SUBJECT, [NAME]: 'Motie' }),
    ]);

    const doc = new Loro.LoroDoc();
    doc.getText('content').insert(0, 'Verzoekt het college');
    doc.getMap('properties').set(NAME, 'Speeltuin');
    await first.call('applyCommit', [
      JSON.stringify({
        'https://atomicdata.dev/properties/subject': SUBJECT,
        'https://atomicdata.dev/properties/loroUpdate': encodeB64(
          doc.export({ mode: 'update' }),
        ),
      }),
    ]);

    // The editor closes and opens again: a new page, the same tab.
    const second = createMockHost(storage);
    const [row] = (await second.call('getResourcesWithSnapshots', [
      [SUBJECT],
    ])) as Array<{ jsonAd: string; snapshot: string }>;
    const again = new Loro.LoroDoc();
    again.import(decodeB64(row.snapshot));

    expect(again.getText('content').toString()).toBe('Verzoekt het college');
    expect(JSON.parse(row.jsonAd)[NAME]).toBe('Speeltuin');
  });

  it('writes the body of a document seeded with Markdown text', async () => {
    const storage = memoryStorage();
    storage.setItem(
      MEMORY_HOST_PREFIX + SUBJECT,
      JSON.stringify({
        jsonAd: { [NAME]: 'Motie', [IS_A]: [DOCUMENT_V2] },
        snapshot: null,
        text: '## Verzoekt het college\n\n- de **speeltuin** te behouden\n',
      }),
    );
    const host = createMockHost(storage);
    const [row] = (await host.call('getResourcesWithSnapshots', [
      [SUBJECT],
    ])) as Array<{ jsonAd: string; snapshot: string }>;
    const doc = new Loro.LoroDoc();
    doc.import(decodeB64(row.snapshot));
    const body = doc.getMap('doc').toJSON() as {
      children: Array<{
        nodeName: string;
        attributes: object;
        children: unknown[];
      }>;
    };

    expect(body.children.map(c => c.nodeName)).toEqual([
      'heading',
      'bulletList',
    ]);
    expect(body.children[0].attributes).toEqual({ level: 2 });
    expect(JSON.stringify(body.children[1])).toContain('speeltuin');
    // Its properties stay what they were.
    expect(doc.getMap('properties').get(NAME)).toBe('Motie');
    expect(JSON.parse(row.jsonAd)[NAME]).toBe('Motie');
    // Written once: the next page reads the same snapshot.
    const again = createMockHost(storage);
    const [second] = (await again.call('getResourcesWithSnapshots', [
      [SUBJECT],
    ])) as Array<{ snapshot: string }>;
    expect(second.snapshot).toBe(row.snapshot);
  });

  it('signs as an agent of its own, the same one for the whole tab', async () => {
    const storage = memoryStorage();
    const agent = await createMockHost(storage).call('agent', []);

    expect(String(agent)).toMatch(/^did:ad:agent:/);
    expect(await createMockHost(storage).call('agent', [])).toBe(agent);
    expect(typeof (await createMockHost(storage).call('sign', ['data']))).toBe(
      'string',
    );
  });

  it('the sandbox without storage has no agent and keeps nothing', async () => {
    const host = createMockHost();

    await expect(host.call('agent', [])).rejects.toThrow();
  });
});
