import { setupError } from './setupError';
import { expect, it } from 'vitest';
import { listAppSetups, getAppSetup } from './registry';
import { validateSetupArguments } from '@tomic/lib';

it('redacts credential values from reported host errors', () => {
  expect(
    setupError(new Error('Failed using my-token then my-token'), 'my-token'),
  ).toBe('Failed using [redacted] then [redacted]');
});

it('shares Notion manual setup with the assistant and validates before installation', () => {
  const adapter = getAppSetup('notion');
  const declaration = listAppSetups().find(a => a.id === 'notion')!;
  expect(declaration.inputSchema).toEqual(adapter.declaration.inputSchema);
  expect(Object.keys(declaration.inputSchema.properties)).toEqual([
    'dataSource',
  ]);
  expect(
    adapter.prepare!({ dataSource: ' AABBCCDD00112233445566778899AABB ' }),
  ).toEqual({
    dataSource: 'aabbccdd-0011-2233-4455-66778899aabb',
  });

  for (const dataSource of [
    '',
    'https://notion.so/a-database',
    '../database',
  ]) {
    expect(() => adapter.prepare!({ dataSource })).toThrow();
  }

  expect(() =>
    validateSetupArguments(declaration, {
      dataSource: 'aabbccdd-0011-2233-4455-66778899aabb',
      token: 'private',
    }),
  ).toThrow('Unknown setup argument');
  expect(() => getAppSetup('untrusted-source')).toThrow();
});
