// @wc-ignore-file
import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VIEW_CLIENT_SOURCE,
  appFrameDocument,
  frameCspDirectives,
} from './appFrameDocument';

const serverFile = (name: string) =>
  new URL(`../../../../../server/src/${name}`, import.meta.url);

describe('appFrameDocument', () => {
  it('carries the CSP and no connect-src', () => {
    const html = appFrameDocument({ source: 'x', client: 'y', nonce: 'N1' });

    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("script-src 'nonce-N1' blob:");
    expect(html).toContain('<script type="module" nonce="N1">');
  });

  it('keeps a </script> in the source from closing the data block', () => {
    const source = 'export const view = () => "</script><script>alert(1)</script>";';
    const html = appFrameDocument({ source, client: 'c', nonce: 'N' });
    const block = html.match(
      /<script type="application\/json" id="__atomic_sources">([\s\S]*?)<\/script>/,
    )![1];

    expect(block).not.toContain('<');
    expect(JSON.parse(block)).toEqual({ source, client: 'c' });
  });

  it('reports errors and the ready signal like the server shell', () => {
    const html = appFrameDocument({ source: '', client: '', nonce: 'N' });
    const server = fs.readFileSync(
      serverFile('handlers/plugin_ui.rs'),
      'utf-8',
    );

    for (const part of [
      "type: '__atomic_plugin_rendered'",
      "type: '__atomic_plugin_error'",
      "type: '__atomic_plugin_ready'",
      "'__atomic_style'",
      "window.addEventListener('unhandledrejection'",
    ]) {
      expect(html).toContain(part);
      expect(server).toContain(part);
    }
  });

  it('keeps the CSP directives of the server frame', () => {
    const server = fs.readFileSync(
      serverFile('handlers/plugin_ui.rs'),
      'utf-8',
    );
    const body = server.match(/fn frame_csp[\s\S]*?\n}\n/)![0];
    const literal = [...body.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)]
      .map(m => m[1].replace(/\\\n\s*/g, ''))
      .join('');
    const directives = Object.fromEntries(
      literal
        .replace('{nonce}', 'N')
        .split(';')
        .map(d => d.trim())
        .filter(Boolean)
        .map(d => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]),
    );
    const ours = frameCspDirectives('N');

    // A meta tag cannot carry `sandbox` (the iframe attribute does).
    delete directives.sandbox;

    // Where the srcdoc differs on purpose: no server to be 'self' of, and the
    // sources are imported through blob URLs.
    expect(directives['script-src']).toBe("'nonce-N'");
    expect(ours['script-src']).toBe("'nonce-N' blob:");
    expect(directives['style-src']).toBe("'unsafe-inline' 'self'");
    expect(directives['img-src']).toBe("'self' data: blob:");
    expect(directives['font-src']).toBe("'self' data:");
    const strip = (v: string) => v.replace(/'self' ?/g, '').trim();

    for (const name of Object.keys(directives)) {
      if (name === 'script-src') continue;
      expect(ours[name], name).toBe(strip(directives[name]));
    }

    // Only form-action is ours alone (the server's sandbox has no forms).
    expect(Object.keys(ours).sort()).toEqual(
      [...Object.keys(directives), 'form-action'].sort(),
    );
  });

  it('ships the same client as the server', () => {
    const file = serverFile('plugins/assets/view-client.js');

    // The browser build cannot see server/ (CI builds it on its own), so this
    // is a copy; it must not drift.
    if (!fs.existsSync(file)) return;
    expect(VIEW_CLIENT_SOURCE).toBe(fs.readFileSync(file, 'utf-8'));
  });
});
