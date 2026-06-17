import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanGeneratedTextLine,
  optionalGeneratedData,
  selectGenerativeFeaturesModel,
} from './useGenerativeData';
import { AIProvider } from '@components/AI/aiContstants';

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

    expect(warn).toHaveBeenCalledWith(
      'AI chat title generation failed',
      error,
    );
  });
});

describe('cleanGeneratedTextLine', () => {
  it('keeps a plain generated line', () => {
    expect(cleanGeneratedTextLine('Project planning')).toBe(
      'Project planning',
    );
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
  const openRouterModel = {
    id: 'google/gemma-3-4b-it',
    provider: AIProvider.OpenRouter,
  };
  const ollamaModel = {
    id: 'qwen3:6b',
    provider: AIProvider.Ollama,
  };

  it('uses the configured generative features model when available', () => {
    expect(
      selectGenerativeFeaturesModel(openRouterModel, ollamaModel, () => true),
    ).toBe(openRouterModel);
  });

  it('falls back to the default chat model when the generative features provider is unavailable', () => {
    expect(
      selectGenerativeFeaturesModel(
        openRouterModel,
        ollamaModel,
        provider => provider === AIProvider.Ollama,
      ),
    ).toBe(ollamaModel);
  });

  it('returns undefined when neither provider is available', () => {
    expect(
      selectGenerativeFeaturesModel(openRouterModel, ollamaModel, () => false),
    ).toBeUndefined();
  });
});
