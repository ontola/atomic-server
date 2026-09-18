import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanGeneratedTextLine,
  optionalGeneratedData,
  selectGenerativeFeaturesModel,
} from './useGenerativeData';

describe('optionalGeneratedData', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns generated data', async () => {
    await expect(
      optionalGeneratedData('unused', 'fallback', async () => 'generated'),
    ).resolves.toBe('generated');
  });

  it('falls back when optional structured output cannot be parsed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error(
      'No object generated: could not parse the response.',
    );

    await expect(
      optionalGeneratedData('AI chat title generation failed', undefined, () =>
        Promise.reject(error),
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('AI chat title generation failed', error);
  });
});

describe('cleanGeneratedTextLine', () => {
  it('keeps a plain generated line', () => {
    expect(cleanGeneratedTextLine('Project planning')).toBe('Project planning');
  });

  it('strips Qwen reasoning blocks and surrounding formatting', () => {
    expect(
      cleanGeneratedTextLine(
        '<think>I should make this short.</think>\n"Project planning"',
      ),
    ).toBe('Project planning');
  });

  it('returns undefined for empty output', () => {
    expect(cleanGeneratedTextLine('<think>reasoning only</think>')).toBe(
      undefined,
    );
  });
});

describe('selectGenerativeFeaturesModel', () => {
  const genModel = { id: 'google/gemma-3-4b-it' };
  const chatModel = { id: 'qwen3:6b' };

  it('uses the generative features model when the endpoint is available', () => {
    expect(selectGenerativeFeaturesModel(genModel, chatModel, true)).toBe(
      genModel,
    );
  });

  it('returns undefined when the endpoint is unavailable', () => {
    expect(
      selectGenerativeFeaturesModel(genModel, chatModel, false),
    ).toBeUndefined();
  });
});
