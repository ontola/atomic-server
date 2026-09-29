import { expect, it, vi } from 'vitest';
import { pcmWav, voiceRequest } from './voiceTurn';
import { managedFetch } from '@helpers/managed/api';
vi.mock('@helpers/managed/api', () => ({ managedFetch: vi.fn() }));
it('encodes bounded mono PCM with matching RIFF and sample lengths', () => {
  const bytes = pcmWav(new Float32Array([-2, 0, 2]));
  const view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
  expect(view.getUint32(4, true)).toBe(bytes.length - 8);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(40, true)).toBe(6);
  expect(view.getInt16(44, true)).toBe(-32768);
  expect(view.getInt16(48, true)).toBe(32767);
});
it('uses the managed credit route and propagates cancellation without retrying', async () => {
  vi.mocked(managedFetch).mockRejectedValueOnce(
    new DOMException('Aborted', 'AbortError'),
  );
  const controller = new AbortController();
  await expect(
    voiceRequest('speak', 'Hello', controller.signal),
  ).rejects.toThrow('Aborted');
  expect(managedFetch).toHaveBeenCalledTimes(1);
  expect(managedFetch).toHaveBeenCalledWith(
    '/ai/voice',
    expect.objectContaining({
      signal: controller.signal,
      body: JSON.stringify({ kind: 'speak', data: 'Hello', accepted: true }),
    }),
  );
});
