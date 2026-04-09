import { describe, it } from 'vitest';
import { encodeB64 } from './base64.js';
import { commits } from './ontologies/commits.js';
import { JSONADParser } from './parse.js';
import { core } from './ontologies/core.js';
import { Resource } from './resource.js';

const EXAMPLE_SUBJECT = 'http://example.com/1';
const EXAMPLE_SUBJECT2 = 'http://example.com/2';
const EXAMPLE_SUBJECT3 = 'http://example.com/3';

const STRING_PROPERTY = 'http://example.com/some-string-property';
const NUMBER_PROPERTY = 'http://example.com/some-number-property';
const BOOLEAN_PROPERTY = 'http://example.com/some-boolean-property';
const NESTED_RESOURCE_PROPERTY =
  'http://example.com/some-nested-resource-property';
describe('parse.ts', () => {
  it('parses a JSON-AD object and returns it as a resource', ({ expect }) => {
    const jsonObject = {
      '@id': EXAMPLE_SUBJECT,
      [STRING_PROPERTY]: 'Hoi',
      [NUMBER_PROPERTY]: 10,
      [BOOLEAN_PROPERTY]: true,
    };

    const parser = new JSONADParser();
    const [resource] = parser.parse(jsonObject);

    expect(resource.get(STRING_PROPERTY)).toBe('Hoi');
    expect(resource.get(NUMBER_PROPERTY)).toBe(10);
    expect(resource.get(BOOLEAN_PROPERTY)).toBe(true);
  });

  it('parses an array of jsonObjects', ({ expect }) => {
    const array = [
      {
        '@id': EXAMPLE_SUBJECT,
        [STRING_PROPERTY]: 'First Resource',
      },
      {
        '@id': EXAMPLE_SUBJECT2,
        [STRING_PROPERTY]: 'Second Resource',
      },
      {
        '@id': EXAMPLE_SUBJECT3,
        [STRING_PROPERTY]: 'Third Resource',
        [NESTED_RESOURCE_PROPERTY]: {
          [STRING_PROPERTY]: 'Nested Resource',
        },
      },
    ];

    const parser = new JSONADParser();
    const resources = parser.parse(array);

    expect(resources).toHaveLength(3);
  });

  it('Handles resources without an ID', ({ expect }) => {
    const jsonObject = {
      [STRING_PROPERTY]: 'Hoi',
    };

    const parser = new JSONADParser();
    const [resource] = parser.parse(jsonObject, 'my-new-id');

    expect(resource.get(STRING_PROPERTY)).toBe('Hoi');
    expect(resource.subject).toBe('my-new-id');
  });

  it('heals missing parent and isA from hydrated JSON when the loro snapshot is stale', async ({
    expect,
  }) => {
    const legacy = new Resource(EXAMPLE_SUBJECT);
    await legacy.set(STRING_PROPERTY, 'Hoi', false);
    const snapshot = (legacy as any)._loroDoc.export({
      mode: 'snapshot',
    }) as Uint8Array;

    const parser = new JSONADParser();
    const [resource] = parser.parse({
      '@id': EXAMPLE_SUBJECT,
      [STRING_PROPERTY]: 'Hoi',
      [core.properties.parent]: 'did:ad:test-drive',
      [core.properties.isA]: ['https://atomicdata.dev/classes/Document'],
      [core.properties.name]: 'Test doc',
      [commits.properties.loroUpdate]: {
        type: 'lorodoc',
        data: encodeB64(snapshot),
      },
    });

    expect(resource.get(core.properties.parent)).toBe('did:ad:test-drive');
    expect(resource.get(core.properties.isA)).toEqual([
      'https://atomicdata.dev/classes/Document',
    ]);
    expect(resource.hasUnsavedChanges()).toBe(false);

    const loroJson = (resource as any)._loroDoc.getMap('properties').toJSON();
    expect(loroJson[core.properties.parent]).toBe('did:ad:test-drive');
    expect(loroJson[core.properties.isA]).toBe(
      JSON.stringify(['https://atomicdata.dev/classes/Document']),
    );
  });
});
