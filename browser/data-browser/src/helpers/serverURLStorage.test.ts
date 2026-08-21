import { describe, it, expect, beforeEach } from 'vitest';

/**
 * This package's tests run in plain node, so there is no `localStorage` to
 * clear. A map is enough: the module under test only reads and writes strings.
 * Installed before the import below, which touches storage at module scope.
 */
class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

(globalThis as unknown as { localStorage: MemoryStorage }).localStorage =
  new MemoryStorage();

const { serverURLStorage } = await import('./serverURLStorage');

/**
 * Which write wins on the next launch.
 *
 * A stored server used to be a single fact. It was written both by choosing a
 * server and by merely opening a drive whose subject is an http(s) URL — and
 * the second kind pinned a public server that a device with its own node then
 * booted against every launch. These assert the two are told apart.
 */
describe('serverURLStorage explicit marking', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('a chosen server is marked as chosen', () => {
    serverURLStorage.set('https://example.com', true);

    expect(serverURLStorage.get()).toBe('https://example.com');
    expect(serverURLStorage.wasExplicitlyChosen()).toBe(true);
  });

  it('a drive-derived server is stored but not chosen', () => {
    serverURLStorage.set('https://atomicdata.dev');

    expect(serverURLStorage.get()).toBe('https://atomicdata.dev');
    expect(serverURLStorage.wasExplicitlyChosen()).toBe(false);
  });

  it('a later drive-derived server retires the earlier choice', () => {
    serverURLStorage.set('https://chosen.example', true);
    // Opening a foreign drive moves the app; the old marker must not keep
    // vouching for a server we have left.
    serverURLStorage.set('https://atomicdata.dev');

    expect(serverURLStorage.wasExplicitlyChosen()).toBe(false);
  });

  it('a marker for a different server does not vouch for this one', () => {
    serverURLStorage.set('https://chosen.example', true);
    // Simulate storage written by an older build: the URL moved on, the
    // marker did not.
    localStorage.setItem('serverUrl', JSON.stringify('https://atomicdata.dev'));

    expect(serverURLStorage.wasExplicitlyChosen()).toBe(false);
  });

  it('storage written before the distinction existed counts as not chosen', () => {
    // Exactly the state that stranded the desktop app: a URL, no marker.
    localStorage.setItem('serverUrl', JSON.stringify('https://atomicdata.dev'));

    expect(serverURLStorage.get()).toBe('https://atomicdata.dev');
    expect(serverURLStorage.wasExplicitlyChosen()).toBe(false);
  });
});
