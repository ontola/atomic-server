import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripUnusedTauriPreloads } from './tauriHtml';

const indexHtml = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../index.html'),
  'utf8',
);

describe('stripUnusedTauriPreloads', () => {
  it('drops leftover WASM preloads and the atomicdata.dev preconnect', () => {
    const html = `
      <link rel="preload" href="/wasm/atomic_wasm_bg.wasm?v=1" />
      <link rel="preload" href="/wasm/atomic_wasm.js?v=1" />
      <link rel="preconnect" href="https://atomicdata.dev" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <div id="boot-splash"></div>
    `;

    const stripped = stripUnusedTauriPreloads(html);

    expect(stripped).not.toMatch(/href="[^"]*\/wasm\//);
    expect(stripped).not.toContain('href="https://atomicdata.dev"');
    expect(stripped).toContain('fonts.googleapis.com');
    expect(stripped).toContain('id="boot-splash"');
  });

  it('strips the atomicdata.dev preconnect from the real index.html', () => {
    expect(indexHtml).toContain('href="https://atomicdata.dev"');

    const stripped = stripUnusedTauriPreloads(indexHtml);

    expect(stripped).not.toContain('href="https://atomicdata.dev"');
    expect(stripped).toContain('id="boot-splash"');
    expect(stripped).toContain('fonts.googleapis.com');
  });

  it('leaves HTML that has nothing to strip unchanged in substance', () => {
    const html = '<html><head></head><body><div id="root"></div></body></html>';

    expect(stripUnusedTauriPreloads(html)).toBe(html);
  });
});
