import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Datatype } from './datatypes.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { dataBrowser } from './ontologies/dataBrowser.js';
import { proxyPathUrl } from './client.js';
import { Store, isEmbeddedVocabulary } from './store.js';

const HOST = 'https://node.example.com';
const defaults = JSON.parse(
  readFileSync(
    new URL('../../../lib/defaults/default_store.json', import.meta.url),
    'utf8',
  ),
) as Array<Record<string, unknown>>;
const definitions = new Map(defaults.map(record => [record['@id'], record]));
const properties = [
  [server.properties.responseMessage, Datatype.STRING],
  [server.properties.status, Datatype.INTEGER],
  [dataBrowser.properties.resources, Datatype.RESOURCEARRAY],
] as const;

describe('vocabulary used while bootstrapping an app', () => {
  it.each(properties)(
    'bundles Property %s with datatype %s',
    (subject, datatype) => {
      const record = definitions.get(subject);
      expect(record).toBeDefined();
      expect(record![core.properties.isA]).toEqual([core.classes.property]);
      expect(record![core.properties.datatype]).toBe(datatype);
      expect(isEmbeddedVocabulary(subject)).toBe(true);
    },
  );

  it('bundles the endpoint-response class and its required fields', () => {
    const record = definitions.get(server.classes.endpointResponse);
    expect(record).toBeDefined();
    expect(record![core.properties.requires]).toEqual([
      server.properties.status,
      server.properties.responseMessage,
    ]);
    expect(isEmbeddedVocabulary(server.classes.endpointResponse)).toBe(true);
  });

  it.each(properties)(
    'validates %s through the installed host without a catalog request',
    async (subject, datatype) => {
      const record = definitions.get(subject);
      expect(record).toBeDefined();
      const store = new Store({ serverUrl: HOST, connect: false });
      store.setServerConnected(true);
      const requested: string[] = [];
      store.injectFetch(async input => {
        const url = String(input);
        requested.push(url);
        expect(new URL(url).origin).toBe(HOST);

        return new Response(JSON.stringify(record), {
          headers: { 'Content-Type': 'application/ad+json' },
        });
      });

      expect((await store.getProperty(subject)).datatype).toBe(datatype);
      expect(requested).toEqual([proxyPathUrl(HOST, subject)]);
    },
  );
});
