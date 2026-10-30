// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { appFrameDocument } from './appFrameDocument';

describe('appFrameDocument', () => {
  it('carries the CSP and no connect-src', () => {
    const html = appFrameDocument({ source: 'x', client: 'y', nonce: 'N1' });

    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("script-src 'nonce-N1' blob:");
    expect(html).toContain('<script type="module" nonce="N1">');
  });

  it('keeps a </script> in the source from closing the data block', () => {
    const source =
      'export const view = () => "</script><script>alert(1)</script>";';
    const html = appFrameDocument({ source, client: 'c', nonce: 'N' });
    const block = html.match(
      /<script type="application\/json" id="__atomic_sources">([\s\S]*?)<\/script>/,
    )![1];

    expect(block).not.toContain('<');
    expect(JSON.parse(block)).toEqual({ source, client: 'c' });
  });
});
