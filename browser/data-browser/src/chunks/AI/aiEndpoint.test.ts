import { describe, expect, it } from 'vitest';
import {
  isEndpointConfigured,
  normalizeModelIdValue,
  normalizeModelIdentifier,
} from './aiEndpoint';

describe('isEndpointConfigured', () => {
  it('requires a key for OpenRouter', () => {
    expect(
      isEndpointConfigured('https://openrouter.ai/api/v1', undefined),
    ).toBe(false);
    expect(
      isEndpointConfigured('https://openrouter.ai/api/v1', 'sk-or-test'),
    ).toBe(true);
  });

  it('allows Ollama without a key', () => {
    expect(isEndpointConfigured('http://localhost:11434/v1', undefined)).toBe(
      true,
    );
  });
});

describe('normalizeModelIdentifier', () => {
  it('keeps id and drops legacy provider', () => {
    expect(
      normalizeModelIdentifier({ id: 'qwen3:6b', provider: 'ollama' }),
    ).toEqual({ id: 'qwen3:6b' });
  });
});

describe('normalizeModelIdValue', () => {
  it('strips legacy provider prefixes', () => {
    expect(normalizeModelIdValue('openrouter:google/gemini')).toBe(
      'google/gemini',
    );
    expect(normalizeModelIdValue('ollama:qwen3:6b')).toBe('qwen3:6b');
    expect(normalizeModelIdValue('plain-id')).toBe('plain-id');
  });
});
