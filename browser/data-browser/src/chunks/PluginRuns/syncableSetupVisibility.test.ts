import { expect, it } from 'vitest';
import { core, type Resource } from '@tomic/lib';
import { platformLocalId } from './syncablePlatform';
import {
  hiddenSyncableSetups,
  syncableSetupSubjects,
} from './syncableSetupVisibility';

const terms = {
  appClass: 'class:app',
  dataProperty: 'property:data',
  properties: {
    'syncable-platform-setup': 'property:setup',
    'builtin-app': 'property:builtin',
    'syncable-platform-id': 'property:platform',
    'syncable-proxy-origin': 'property:proxy',
  },
};
const subject = 'https://atomic.example/setup';
const localId = platformLocalId('https://proxy.example', 'calendar-service');
const props = {
  [core.properties.isA]: [terms.appClass],
  [core.properties.localId]: localId,
  [terms.dataProperty]: subject,
  [terms.properties['syncable-platform-setup']]: true,
  [terms.properties['builtin-app']]: 'syncables',
  [terms.properties['syncable-platform-id']]: 'calendar-service',
  [terms.properties['syncable-proxy-origin']]: 'https://proxy.example',
};

function resource(values: Record<string, unknown>) {
  return { subject, get: (property: string) => values[property] } as Pick<
    Resource,
    'subject' | 'get'
  >;
}

it('hides a validated setup App while leaving an installed principal App visible', () => {
  const rows = new Map([[subject, resource(props)]]);
  expect([
    ...hiddenSyncableSetups({ [localId]: subject }, rows, terms),
  ]).toEqual([subject]);
  rows.set(
    subject,
    resource({
      ...props,
      [terms.properties['syncable-platform-setup']]: false,
    }),
  );
  expect(hiddenSyncableSetups({ [localId]: subject }, rows, terms).size).toBe(
    0,
  );
});

it('retains unrelated or partially migrated resources despite an index pointer and a familiar local ID', () => {
  for (const changed of [
    { [terms.properties['builtin-app']]: 'ordinary-app' },
    { [core.properties.isA]: ['class:table'] },
    { [terms.properties['syncable-proxy-origin']]: 'https://other.example' },
    { [terms.dataProperty]: 'https://atomic.example/old-accounts' },
    { [terms.properties['syncable-platform-setup']]: undefined },
    { [core.properties.localId]: 'user-table' },
  ]) {
    expect(
      hiddenSyncableSetups(
        { [localId]: subject },
        new Map([[subject, resource({ ...props, ...changed })]]),
        terms,
      ).size,
    ).toBe(0);
  }

  expect(
    hiddenSyncableSetups(
      { unrelated: subject },
      new Map([[subject, resource(props)]]),
      terms,
    ).size,
  ).toBe(0);
});

it('does not fetch external, credential-bearing or malformed editable index URLs', () => {
  for (const value of [
    'https://other.example/data',
    'http://127.0.0.1:1234/data',
    'https://user:password@atomic.example/data',
    'https://atomic.example/data#fragment',
    'not a subject',
  ])
    expect(
      syncableSetupSubjects({ [localId]: value }, 'https://atomic.example'),
    ).toEqual([]);
  expect(
    syncableSetupSubjects({ [localId]: subject }, 'https://atomic.example'),
  ).toEqual([subject]);
  expect(syncableSetupSubjects([], 'https://atomic.example')).toEqual([]);
});
