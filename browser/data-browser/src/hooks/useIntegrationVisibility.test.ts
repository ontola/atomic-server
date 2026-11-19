import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';
import {
  dropSaved,
  carryOver,
  retryDriveRead,
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

describe('carryOver', () => {
  it('queues an opt-in that only the cache holds', () => {
    expect(
      carryOver(
        {},
        { 'show-api-plugins': true, 'show-experimental-plugins': true },
      ),
    ).toEqual({ 'show-api-plugins': true, 'show-experimental-plugins': true });
  });

  it('leaves alone what the drive already answers, and the default', () => {
    expect(
      carryOver(
        { 'show-api-plugins': false },
        { 'show-api-plugins': true, 'show-experimental-plugins': false },
      ),
    ).toEqual({});
  });
});

describe('retryDriveRead', () => {
  afterEach(() => vi.useRealTimers());

  it('asks the server again until the drive reads without an error', async () => {
    vi.useFakeTimers();
    const fetchResourceFromServer = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce({ error: new Error('could not be read') })
      .mockResolvedValue({});
    const stop = retryDriveRead(
      { fetchResourceFromServer } as unknown as Store,
      'atomic:drive',
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchResourceFromServer).toHaveBeenCalledTimes(3);
    expect(fetchResourceFromServer).toHaveBeenCalledWith('atomic:drive');
    stop();
  });

  it('stops asking when cancelled', async () => {
    vi.useFakeTimers();
    const fetchResourceFromServer = vi.fn();

    retryDriveRead(
      { fetchResourceFromServer } as unknown as Store,
      'atomic:drive',
    )();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchResourceFromServer).not.toHaveBeenCalled();
  });
});
