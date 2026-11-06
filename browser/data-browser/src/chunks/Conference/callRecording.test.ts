// @wc-ignore-file
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ managedFetch: vi.fn() }));

vi.mock('../../helpers/managed/api', () => ({
  managedFetch: mocks.managedFetch,
}));

import { startRecording, stopRecording, withRecording } from './callRecording';

afterEach(() => vi.clearAllMocks());

describe('recording a call', () => {
  it('starts with the room of the meeting, and stops by egress id', async () => {
    mocks.managedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          egressId: 'EG_1',
          mediaUrl: 'https://lk/recordings/abc.mp4',
          transcriptUrl: 'https://lk/recordings/abc.vtt',
        }),
      ),
    );
    const started = await startRecording('did:ad:meeting', 1000);

    const [path, init] = mocks.managedFetch.mock.calls[0];
    expect(path).toBe('/meetings/recording/start');
    expect(JSON.parse(init.body).room).toMatch(/^[0-9a-f]{64}$/);
    expect(started).toEqual({
      egressId: 'EG_1',
      recording: {
        mediaUrl: 'https://lk/recordings/abc.mp4',
        transcriptUrl: 'https://lk/recordings/abc.vtt',
        startedAt: 1000,
      },
    });

    mocks.managedFetch.mockResolvedValueOnce(new Response('{}'));
    await stopRecording('EG_1');
    expect(mocks.managedFetch.mock.calls[1][0]).toBe(
      '/meetings/recording/stop',
    );
    expect(JSON.parse(mocks.managedFetch.mock.calls[1][1].body)).toEqual({
      egressId: 'EG_1',
    });
  });

  it('throws when the server has no recording', async () => {
    mocks.managedFetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(startRecording('did:ad:meeting')).rejects.toThrow('503');
  });

  it('keeps the recordings in order, one per file', () => {
    const a = { mediaUrl: 'a.mp4', startedAt: 2 };
    const b = { mediaUrl: 'b.mp4', startedAt: 1 };

    expect(withRecording(undefined, a)).toEqual([a]);
    expect(withRecording([a, 'junk'], b)).toEqual([b, a]);
    // Stopping replaces the running one with its end time.
    expect(withRecording([b, a], { ...a, endedAt: 3 })).toEqual([
      b,
      { ...a, endedAt: 3 },
    ]);
  });
});
