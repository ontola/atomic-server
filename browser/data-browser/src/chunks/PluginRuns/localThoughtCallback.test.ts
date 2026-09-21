import { expect, it, vi } from 'vitest';
import {
  callbackEntry,
  completedPlatformForEntry,
  finishLocalThoughtCallback,
} from './localThoughtCallback';

const pending = {
  state: 'state',
  drive: 'did:ad:drive',
  actor: 'did:ad:agent',
  platform: 'google-calendar',
  origin: 'https://proxy.example',
};

it('routes a Calendar callback to its pending connection when API cards are absent', async () => {
  const finish = vi.fn().mockResolvedValue({
    connection: 'connection',
    platform: 'google-calendar',
  });
  const persist = vi.fn();

  await expect(
    finishLocalThoughtCallback({
      callback: {
        state: 'state',
        code: 'single-use-code',
        platform: 'google-calendar',
      },
      pending,
      drive: pending.drive,
      actor: pending.actor,
      origin: 'https://other-proxy.example',
      finish,
      persist,
      cancel: vi.fn(),
    }),
  ).resolves.toBe('google-calendar');

  expect(finish).toHaveBeenCalledWith({
    drive: pending.drive,
    state: pending.state,
    connectionCode: 'single-use-code',
    origin: pending.origin,
  });
  expect(persist).toHaveBeenCalledWith(
    expect.objectContaining({
      platform: 'google-calendar',
      connection: 'connection',
      origin: pending.origin,
    }),
  );
});

it('reopens only the originating setup card and supplies safe fallback targets', () => {
  expect(callbackEntry({ ...pending, entry: 'devonian-todoist' })).toBe(
    'devonian-todoist',
  );
  expect(callbackEntry(pending)).toBe('proxy:google-calendar');
  expect(
    callbackEntry({ ...pending, platform: 'pets', entry: undefined }),
  ).toBe('proxy:pets');

  const completed = {
    drive: pending.drive,
    actor: pending.actor,
    origin: pending.origin,
    entry: 'devonian-todoist',
    platform: pending.platform,
    expires: Date.now() + 1_000,
  };
  const base = {
    drive: pending.drive,
    actor: pending.actor,
    origin: pending.origin,
  };
  expect(
    completedPlatformForEntry(completed, {
      ...base,
      entry: 'devonian-todoist',
    }),
  ).toBe('google-calendar');
  expect(
    completedPlatformForEntry(completed, {
      ...base,
      entry: 'proxy:google-calendar',
    }),
  ).toBeUndefined();
});
