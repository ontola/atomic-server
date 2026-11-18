import { afterEach, describe, it, vi } from 'vitest';
import { Datatype, validateDatatype } from './datatypes.js';
import {
  allowLensEndpointKeysInRenders,
  isLensEndpointKey,
} from './lens-endpoint-key.js';
import type { Property } from './store.js';
import { testStore } from './test-store.js';

const TODOIST_TASK = 'record:APIs/todoist.com/1#task';
const SOLID_BOOKMARK = 'rdf:http://www.w3.org/2002/01/bookmark#Bookmark';
const CLASS =
  'https://ontola.github.io/atomic-plugins/ontology/classes/issue-v1';

afterEach(() => allowLensEndpointKeysInRenders(() => false));

describe('lens endpoint keys', () => {
  it('recognises record: and rdf: keys, nothing else', ({ expect }) => {
    for (const key of [TODOIST_TASK, 'record:todoist.com#task', SOLID_BOOKMARK])
      expect(isLensEndpointKey(key), key).toBe(true);

    for (const value of [
      CLASS,
      'record:APIs/todoist.com/1',
      'record:#task',
      'record:a#b#c',
      'record:APIs/todo ist.com/1#task',
      'rdf:Bookmark',
      'rdf:',
      'not a key',
      42,
      undefined,
    ])
      expect(isLensEndpointKey(value), String(value)).toBe(false);
  });

  it('a ResourceArray takes them only when asked', ({ expect }) => {
    expect(() =>
      validateDatatype([CLASS, TODOIST_TASK], Datatype.RESOURCEARRAY),
    ).toThrow(/Not a valid Relative Subject/);
    expect(() =>
      validateDatatype(
        [CLASS, TODOIST_TASK, SOLID_BOOKMARK],
        Datatype.RESOURCEARRAY,
        {
          allowLensEndpointKeys: true,
        },
      ),
    ).not.toThrow();
    // Anything else in the array is still checked.
    expect(() =>
      validateDatatype([TODOIST_TASK, 'not a URL'], Datatype.RESOURCEARRAY, {
        allowLensEndpointKeys: true,
      }),
    ).toThrow(/Invalid URL at \[1\]/);
  });

  describe('Resource.set', () => {
    const property = (shortname: string): Property => ({
      subject: `https://example.com/properties/${shortname}`,
      datatype: Datatype.RESOURCEARRAY,
      shortname,
      description: '',
    });

    async function storeWith(shortname: string) {
      const { store } = await testStore();
      const app = await store.newResource({
        subject: 'https://example.com/app',
      });
      const original = store.getProperty.bind(store);
      store.getProperty = vi.fn(async (subject: string) =>
        subject === property(shortname).subject
          ? property(shortname)
          : original(subject),
      );

      return { app, prop: property(shortname).subject };
    }

    it('refuses an endpoint key in renders while switched off', async ({
      expect,
    }) => {
      const { app, prop } = await storeWith('renders');

      await expect(app.set(prop, [TODOIST_TASK])).rejects.toThrow(
        /Not a valid Relative Subject/,
      );
    });

    it('accepts an endpoint key in renders while switched on', async ({
      expect,
    }) => {
      allowLensEndpointKeysInRenders(() => true);
      const { app, prop } = await storeWith('renders');
      await app.set(prop, [CLASS, TODOIST_TASK]);

      expect(app.get(prop)).toEqual([CLASS, TODOIST_TASK]);
    });

    it('accepts them in renders only, not in other ResourceArrays', async ({
      expect,
    }) => {
      allowLensEndpointKeysInRenders(() => true);
      const { app, prop } = await storeWith('row-extras');

      await expect(app.set(prop, [TODOIST_TASK])).rejects.toThrow(
        /Not a valid Relative Subject/,
      );
    });

    it('reads the switch on every set', async ({ expect }) => {
      let on = false;
      allowLensEndpointKeysInRenders(() => on);
      const { app, prop } = await storeWith('renders');

      await expect(app.set(prop, [TODOIST_TASK])).rejects.toThrow();
      on = true;
      await expect(app.set(prop, [TODOIST_TASK])).resolves.toBeUndefined();
    });
  });
});
