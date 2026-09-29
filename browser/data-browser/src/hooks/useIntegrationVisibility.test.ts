import { describe, expect, it } from 'vitest';
import type { Store } from '@tomic/react';
import {
  dropSaved,
  resolveVisibilitySchema,
  stillUnconfirmed,
} from './useIntegrationVisibility';

describe('dropSaved', () => {
  it('drops saved values and keeps ones toggled again mid-flight', () => {
    expect(
      dropSaved(
        { 'show-api-plugins': false, 'show-experimental-plugins': true },
        [
          ['show-api-plugins', true],
          ['show-experimental-plugins', true],
        ],
      ),
    ).toEqual({ 'show-api-plugins': false });
  });
});

describe('stillUnconfirmed', () => {
  it('confirms saved keys but not ones re-toggled mid-flight', () => {
    const saved: ['show-api-plugins' | 'show-experimental-plugins', boolean][] =
      [
        ['show-api-plugins', true],
        ['show-experimental-plugins', true],
      ];
    const remaining = dropSaved(
      { 'show-api-plugins': false, 'show-experimental-plugins': true },
      saved,
    );

    expect(
      stillUnconfirmed(
        ['show-api-plugins', 'show-experimental-plugins'],
        saved,
        remaining,
      ),
    ).toEqual(['show-api-plugins']);
  });

  it('keeps keys that were not part of the write', () => {
    expect(
      stillUnconfirmed(
        ['show-experimental-plugins'],
        [['show-api-plugins', true]],
        {},
      ),
    ).toEqual(['show-experimental-plugins']);
  });
});

describe('resolveVisibilitySchema', () => {
  const DRIVE = 'atomic:drive';

  /** Only the two reads `resolveVisibilitySchema` makes, standing in for a store. */
  const fakeStore = (
    states: Array<{ error?: Error; reject?: Error; ontology?: string }>,
  ) => {
    let pass = 0;
    const current = () => states[Math.min(pass, states.length - 1)];

    const resource = () => {
      const state = current();

      if (state.reject) return Promise.reject(state.reject);

      return Promise.resolve({
        error: state.error,
        get: () => state.ontology,
      });
    };

    return {
      fetchedFromServer: 0,
      getResource: () => resource(),
      fetchResourceFromServer() {
        this.fetchedFromServer += 1;
        pass += 1;

        return resource();
      },
    };
  };

  it('reports a timed-out read as a failure rather than an empty schema', async () => {
    const store = fakeStore([
      { reject: new Error('Async Request for subject atomic:drive timed out') },
    ]);

    const result = await resolveVisibilitySchema(
      store as unknown as Store,
      DRIVE,
      false,
    );

    expect(result.ok).toBe(false);
    expect(store.fetchedFromServer).toBe(0);
  });

  it('does not read an errored drive resource as a drive without a schema', async () => {
    // The panel's `ready` gate reads this same resource, so calling this an
    // empty schema would leave it unready with nothing asking again.
    const store = fakeStore([{ error: new Error('could not be read') }]);

    expect(
      await resolveVisibilitySchema(store as unknown as Store, DRIVE, false),
    ).toEqual({ ok: false, error: 'Error: could not be read' });
  });

  it('asks the server on a retry, which is the only way the answer can change', async () => {
    const store = fakeStore([
      { reject: new Error('timed out') },
      { ontology: undefined },
    ]);

    expect(
      await resolveVisibilitySchema(store as unknown as Store, DRIVE, true),
    ).toEqual({ ok: true, properties: {} });
    expect(store.fetchedFromServer).toBe(1);
  });
});
