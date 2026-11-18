// @wc-ignore-file
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  allowLensEndpointKeysInRenders,
  Datatype,
  lensEndpointKeysAllowedInRenders,
  validateDatatype,
} from '@tomic/lib';
import { offersForTable, type PieceInfo } from './offers';
import { PIECES_FLAG_KEY, registerPiecesValidation } from './piecesFlag';

const TODOIST_TASK = 'record:APIs/todoist.com/1#task';
let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  registerPiecesValidation();
});

afterEach(() => {
  allowLensEndpointKeysInRenders(() => false);
  vi.unstubAllGlobals();
});

it('lets renders hold lens endpoint keys only while the flag is on', () => {
  expect(lensEndpointKeysAllowedInRenders()).toBe(false);
  storage.set(PIECES_FLAG_KEY, 'true');
  expect(lensEndpointKeysAllowedInRenders()).toBe(true);
  storage.delete(PIECES_FLAG_KEY);
  expect(lensEndpointKeysAllowedInRenders()).toBe(false);
});

it('an integration rendering a record key is offered through the catalog lens', () => {
  storage.set(PIECES_FLAG_KEY, 'true');
  const renders = [TODOIST_TASK];
  expect(() =>
    validateDatatype(renders, Datatype.RESOURCEARRAY, {
      allowLensEndpointKeys: lensEndpointKeysAllowedInRenders(),
    }),
  ).not.toThrow();

  const todoist: PieceInfo = {
    subject: 'https://drive.example/apps/todoist',
    name: 'Todoist',
    kind: 'integration',
    renders,
  };
  const ISSUE =
    'https://ontola.github.io/atomic-plugins/ontology/classes/issue-v1';
  const offers = offersForTable(
    [todoist],
    [
      {
        subject:
          'https://ontola.github.io/atomic-plugins/ontology/lenses/todoist-task-issue-v2',
        name: 'Todoist task ↔ Issue',
        source: TODOIST_TASK,
        target: ISSUE,
        trusted: true,
      },
    ],
    ISSUE,
  );

  expect(offers.map(o => o.piece.name)).toEqual(['Todoist']);
});
