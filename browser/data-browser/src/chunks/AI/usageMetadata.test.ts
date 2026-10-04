import { describe, expect, it } from 'vitest';
import { compactionTokens, usageMetadata } from './usageMetadata';

describe('usageMetadata', () => {
  it('records the last step input as the context size', () => {
    expect(
      usageMetadata({
        type: 'finish-step',
        usage: { inputTokens: 1200, outputTokens: 80 },
      }),
    ).toEqual({ contextTokens: 1200 });
  });

  it('records the summed spend on finish', () => {
    expect(
      usageMetadata({
        type: 'finish',
        totalUsage: { inputTokens: 9000, outputTokens: 400 },
      }),
    ).toEqual({ inputTokensUsed: 9000, outputTokensUsed: 400 });
  });

  it('adds nothing for other parts', () => {
    expect(usageMetadata({ type: 'text-delta' })).toBeUndefined();
  });

  it('leaves the last step as the context size once all parts are merged', () => {
    // Three tool steps: each resends the growing context. The SDK merges
    // every part's metadata into the message in order.
    const parts = [
      { type: 'finish-step', usage: { inputTokens: 1000 } },
      { type: 'finish-step', usage: { inputTokens: 1500 } },
      { type: 'finish-step', usage: { inputTokens: 2100 } },
      { type: 'finish', totalUsage: { inputTokens: 4600, outputTokens: 300 } },
    ] as const;
    const merged = parts.reduce(
      (metadata, part) => ({ ...metadata, ...usageMetadata(part) }),
      {},
    );

    expect(compactionTokens(merged)).toBe(2100);
  });
});

describe('compactionTokens', () => {
  it('prefers the context size over the summed spend', () => {
    expect(
      compactionTokens({ contextTokens: 2100, inputTokensUsed: 4600 }),
    ).toBe(2100);
  });

  it('falls back to the summed spend for messages saved before contextTokens', () => {
    expect(compactionTokens({ inputTokensUsed: 4600 })).toBe(4600);
  });

  it('is zero without usage', () => {
    expect(compactionTokens(undefined)).toBe(0);
  });
});
