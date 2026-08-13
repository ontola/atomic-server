import { describe, it, expect, afterEach } from 'vitest';
import { isRunningInTauri } from './tauri';

/**
 * The globals Tauri injects are not there for the first moments of a page, so
 * `isRunningInTauri` also recognises the origin the shell serves from. That
 * fallback existed but only knew the desktop shape, and the gap was invisible:
 * on Android `getManagedApiBase()` fell through to the same-origin `/api`, and
 * `tauri.localhost/api/me` answers 200 with the SPA's own HTML instead of
 * failing — so a device that had linked successfully was told it had no
 * session by its own index page.
 */
describe('isRunningInTauri', () => {
  const original = globalThis.window;

  afterEach(() => {
    globalThis.window = original;
  });

  /** Neither global injected yet — only the origin can answer. */
  function windowAt(href: string) {
    globalThis.window = {
      location: new URL(href),
    } as unknown as Window & typeof globalThis;
  }

  it('recognises the desktop shell before its globals land', () => {
    windowAt('tauri://localhost/app/sync');
    expect(isRunningInTauri()).toBe(true);
  });

  it('recognises the Android shell, which is http rather than tauri:', () => {
    windowAt('http://tauri.localhost/app/sync');
    expect(isRunningInTauri()).toBe(true);
  });

  it('does not mistake an ordinary web origin for the app', () => {
    windowAt('https://atomicserver.eu/app/sync');
    expect(isRunningInTauri()).toBe(false);

    windowAt('http://localhost:6747/app/sync');
    expect(isRunningInTauri()).toBe(false);
  });

  it('trusts the injected global whatever the origin', () => {
    windowAt('http://localhost:6747/app/sync');
    (globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ =
      {};
    expect(isRunningInTauri()).toBe(true);
  });
});
