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
  it('drops the WASM preloads and atomicdata.dev preconnect from index.html', () => {
    expect(indexHtml).toContain('/wasm/atomic_wasm_bg.wasm');
    expect(indexHtml).toContain('https://atomicdata.dev');

    const stripped = stripUnusedTauriPreloads(indexHtml);

    expect(stripped).not.toContain('/wasm/atomic_wasm_bg.wasm');
    expect(stripped).not.toContain('/wasm/atomic_wasm.js');
    expect(stripped).not.toContain('https://atomicdata.dev');
    // Fonts still load — the app uses them; only unused boot fetches go.
    expect(stripped).toContain('fonts.googleapis.com');
    expect(stripped).toContain('id="boot-splash"');
  });

  it('leaves HTML that has nothing to strip unchanged in substance', () => {
    const html = '<html><head></head><body><div id="root"></div></body></html>';

    expect(stripUnusedTauriPreloads(html)).toBe(html);
  });
});
