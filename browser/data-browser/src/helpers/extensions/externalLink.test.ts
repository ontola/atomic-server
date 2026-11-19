import { describe, expect, it, vi } from 'vitest';
import { externalLink, MAX_EXTERNAL_URL, openInNewTab } from './externalLink';

describe('externalLink', () => {
  it('accepts http(s) links and keeps the full host', () => {
    expect(externalLink('https://www.notion.so/page?x=1#top').host).toBe(
      'www.notion.so',
    );
    expect(externalLink('http://localhost:8080/').host).toBe('localhost:8080');
  });

  it('shows an internationalised host in the form it resolves to', () => {
    // Punycode, so a look-alike cannot pass for the real thing in the bar.
    expect(externalLink('https://аpple.com/').host).toBe('xn--pple-43d.com');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'blob:https://example.com/uuid',
    'file:///etc/passwd',
    'mailto:someone@example.com',
    'ftp://example.com',
    '/relative/path',
    'example.com',
    '',
    'https://user:pass@example.com/',
    'https://bank.example@evil.example/',
    `https://example.com/${'a'.repeat(MAX_EXTERNAL_URL)}`,
  ])('refuses %s', link => {
    expect(() => externalLink(link)).toThrow(/openExternal/);
  });

  it('refuses anything that is not a string', () => {
    expect(() => externalLink({ href: 'https://example.com' })).toThrow();
    expect(() => externalLink(undefined)).toThrow();
  });
});

describe('openInNewTab', () => {
  it('opens with neither an opener nor a referrer', () => {
    const open = vi.fn();
    openInNewTab(new URL('https://example.com/a'), open);
    expect(open).toHaveBeenCalledWith(
      'https://example.com/a',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
