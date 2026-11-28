import { describe, expect, it } from 'vitest';
import { markdownToPlainText } from './markdown.js';

describe('markdownToPlainText', () => {
  it('drops images and HTML, keeps link text', () => {
    expect(
      markdownToPlainText(
        '![logo](https://x.dev/a.svg)<img src="b.png">The *easiest* [way](https://x.dev)',
      ),
    ).toBe('The easiest way');
  });
});
