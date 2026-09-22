import { expect, it, vi } from 'vitest';
import { voiceLevel, observeWords } from './voiceFeedback';

it('ignores background noise, responds to speech and clamps loud input', () => {
  expect(voiceLevel(new Float32Array([0.002, -0.002]))).toBe(0);
  expect(voiceLevel(new Float32Array([0.05, -0.05]))).toBeGreaterThan(0.3);
  expect(voiceLevel(new Float32Array([1, -1]))).toBe(1);
});
it('never starts a cloud recognizer or a late recognizer after cancellation', async () => {
  const start = vi.fn();
  class Recognition {
    processLocally = false;
    start = start;
    abort = vi.fn();
    static available = vi.fn().mockResolvedValue('available');
  }
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('window', { SpeechRecognition: Recognition });

  try {
    const stop = observeWords(vi.fn());
    stop();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(Recognition.available).toHaveBeenCalledWith({
      langs: ['en-US'],
      processLocally: true,
    });
    Recognition.available.mockResolvedValue('unavailable');
    observeWords(vi.fn());
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
