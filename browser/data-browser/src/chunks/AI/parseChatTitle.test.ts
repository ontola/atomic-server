import { describe, expect, it } from 'vitest';
import { parseChatTitle } from './useGenerativeData';

describe('parseChatTitle', () => {
  it('splits a leading emoji from the title', () => {
    expect(parseChatTitle('\u{1F950} Bakery website')).toEqual({
      emoji: '\u{1F950}',
      title: 'Bakery website',
    });
  });

  it('keeps multi-codepoint emoji together', () => {
    // Woman technologist with a skin tone: base + modifier + ZWJ + laptop.
    const emoji = '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}';
    expect(parseChatTitle(`${emoji} Debug the sync`)).toEqual({
      emoji,
      title: 'Debug the sync',
    });
  });

  it('drops an emoji the model appended to the title', () => {
    expect(parseChatTitle('\u{1F3A8} Website design \u{1F680}')).toEqual({
      emoji: '\u{1F3A8}',
      title: 'Website design',
    });
  });

  it('accepts a bare title from models that ignore the emoji instruction', () => {
    expect(parseChatTitle('Plain title')).toEqual({ title: 'Plain title' });
  });

  it('returns nothing for empty output', () => {
    expect(parseChatTitle('   ')).toBeUndefined();
    expect(parseChatTitle(undefined)).toBeUndefined();
  });
});
