import { describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/lib';
import { selectReadableDrive } from './readableDrive';

describe('explicit drive links', () => {
  it.each(['unreadable', 'navigated', 'identity-changed', 'readable'])(
    'only selects a readable drive for the current navigation (%s)',
    async scenario => {
      let agent = {};
      const store = {
        getAgent: () => agent,
        getResource: async () => {
          if (scenario === 'identity-changed') agent = {};

          return {
            error: scenario === 'unreadable' ? new Error('Private') : undefined,
          };
        },
      } as unknown as Store;
      const select = vi.fn();
      const result = await selectReadableDrive(
        store,
        'atomic:drive',
        select,
        () => scenario !== 'navigated',
      );
      expect(result).toBe(scenario === 'readable');
      expect(select).toHaveBeenCalledTimes(scenario === 'readable' ? 1 : 0);
    },
  );
});
