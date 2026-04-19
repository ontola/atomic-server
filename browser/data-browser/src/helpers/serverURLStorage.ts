import { isDev } from '../config';

const ServerURLStorageKEY = 'serverUrl';
const KnownServersKEY = 'knownServers';

// Atomic-Server URLs must be fetchable over HTTP/HTTPS (or iroh: for peer-to-peer).
// Anything else — notably `tauri://localhost` left over from earlier buggy builds —
// is silently rejected on read so it can't poison downstream fetches.
const isValidServerUrl = (url: unknown): url is string =>
  typeof url === 'string' &&
  (url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('iroh:'));

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
  getKnownServers(): string[] {
    try {
      const val = localStorage.getItem(KnownServersKEY);
      if (!val) return [];
      const servers = (JSON.parse(val) as string[]).filter(isValidServerUrl);

      if (!isDev()) {
        return servers;
      }

      return servers.filter(server => server !== window.location.origin);
    } catch (e) {
      return [];
    }
  },
  removeKnownServer(url: string) {
    const known = this.getKnownServers();
    localStorage.setItem(
      KnownServersKEY,
      JSON.stringify(known.filter((s: string) => s !== url)),
    );
  },
};
