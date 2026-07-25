import { isDev } from '../config';

const ServerURLStorageKEY = 'serverUrl';
const KnownServersKEY = 'knownServers';

// Atomic-Server URLs must be fetchable over HTTP/HTTPS.
// Anything else — notably `tauri://localhost` left over from earlier buggy builds —
// is silently rejected on read so it can't poison downstream fetches.
const isValidServerUrl = (url: unknown): url is string =>
  typeof url === 'string' &&
  (url.startsWith('http://') || url.startsWith('https://'));

export const serverURLStorage = {
  set(url: string) {
    if (!isValidServerUrl(url)) return;
    localStorage.setItem(ServerURLStorageKEY, JSON.stringify(url));
    this.addKnownServer(url);
  },
  get(): string | undefined {
    try {
      const val = localStorage.getItem(ServerURLStorageKEY);
      const parsed = JSON.parse(val as string);

      return isValidServerUrl(parsed) ? parsed : undefined;
    } catch (e) {
      return undefined;
    }
  },
  addKnownServer(url: string) {
    if (!isValidServerUrl(url)) return;

    try {
      const urlObj = new URL(url);
      const origin = urlObj.origin;
      if (!isValidServerUrl(origin)) return;
      const known = this.getKnownServers();

      if (!known.includes(origin)) {
        localStorage.setItem(
          KnownServersKEY,
          JSON.stringify([...known, origin]),
        );
      }
    } catch (e) {
      // Not a valid URL, ignore
    }
  },
  /** Everything actually stored, unfiltered — the basis for any write. */
  getStoredServers(): string[] {
    try {
      const val = localStorage.getItem(KnownServersKEY);

      if (!val) return [];

      return (JSON.parse(val) as string[]).filter(isValidServerUrl);
    } catch (e) {
      return [];
    }
  },
  getKnownServers(): string[] {
    const servers = this.getStoredServers();

    if (!isDev()) {
      return servers;
    }

    // In dev the app is served from vite's own origin, which is not a server
    // worth listing. A display concern only — see `removeKnownServer`.
    return servers.filter(server => server !== window.location.origin);
  },
  removeKnownServer(url: string) {
    // Reads raw storage, not `getKnownServers()`: that applies the dev-only
    // display filter above, so writing its result back silently deleted the
    // current origin from storage as a side effect of removing something else.
    const stored = this.getStoredServers();
    localStorage.setItem(
      KnownServersKEY,
      JSON.stringify(stored.filter((s: string) => s !== url)),
    );
  },
};
