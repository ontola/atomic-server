import { describe, expect, it } from 'vitest';
import { Store } from './store.js';
import { JSONADParser } from './parse.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';

/**
 * Someone given one chat out of a drive they can't read is refused that
 * drive's presence channel. Host and guest meet in the channel of the nearest
 * resource carrying its own `read` list: what the invite wrote to.
 */
describe('Store.presenceScope', () => {
  const DRIVE = 'did:ad:drive';
  const ROOM = 'did:ad:room';
  const MESSAGE = 'did:ad:message';
  const FOLDER = 'did:ad:folder';
  const NOTE = 'did:ad:note';

  function setup() {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const parser = new JSONADParser();

    const add = (json: Record<string, unknown>) => {
      for (const r of parser.parse(json, json['@id'] as string)) {
        r.loading = false;
        store.addResource(r);
      }
    };

    add({
      '@id': DRIVE,
      [core.properties.isA]: [server.classes.drive],
      [core.properties.read]: ['did:ad:agent:host'],
    });
    add({
      '@id': ROOM,
      [core.properties.parent]: DRIVE,
      [core.properties.read]: ['did:ad:agent:guest'],
    });
    add({ '@id': MESSAGE, [core.properties.parent]: ROOM });
    add({ '@id': FOLDER, [core.properties.parent]: DRIVE });
    add({ '@id': NOTE, [core.properties.parent]: FOLDER });

    return store;
  }

  it('is the shared resource itself, and so for what is in it', () => {
    const store = setup();
    const room = store.normalizeSubject(ROOM);

    expect(store.presenceScope(ROOM)).toBe(room);
    expect(store.presenceScope(MESSAGE)).toBe(room);
  });

  it('leaves the rest of the drive to the drive channel', () => {
    const store = setup();

    expect(store.presenceScope(NOTE)).toBeUndefined();
    expect(store.presenceScope(DRIVE)).toBeUndefined();
    expect(store.presenceScope('did:ad:not-loaded')).toBeUndefined();
  });
});
