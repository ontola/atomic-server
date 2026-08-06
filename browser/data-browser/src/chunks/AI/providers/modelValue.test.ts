import { describe, expect, it } from 'vitest';
import { AIProvider } from '@components/AI/aiContstants';
import { parseModelValue, serializeModelValue } from './modelValue';

describe('serializeModelValue / parseModelValue', () => {
  it('round-trips OpenRouter models whose ids contain slashes', () => {
    const model = {
      id: 'google/gemini-flash-latest',
      provider: AIProvider.OpenRouter,
    };

    expect(parseModelValue(serializeModelValue(model))).toEqual(model);
  });

  it('round-trips Ollama models whose ids contain colons', () => {
    const model = {
      id: 'qwen3:6b',
      provider: AIProvider.Ollama,
    };

    expect(parseModelValue(serializeModelValue(model))).toEqual(model);
  });

  it('round-trips openai-compatible models', () => {
    const model = {
      id: 'llama-3.3-70b-versatile',
      provider: AIProvider.OpenAICompatible,
    };

    expect(serializeModelValue(model)).toBe(
      'openai-compatible:llama-3.3-70b-versatile',
    );
    expect(parseModelValue(serializeModelValue(model))).toEqual(model);
  });

  it('returns undefined for unknown providers', () => {
    expect(parseModelValue('unknown:gpt')).toBeUndefined();
  });
});
