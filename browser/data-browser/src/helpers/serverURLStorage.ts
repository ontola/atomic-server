const ServerURLStorageKEY = 'serverUrl';
const KnownServersKEY = 'knownServers';

export const serverURLStorage = {
  set(url: string) {
    localStorage.setItem(ServerURLStorageKEY, JSON.stringify(url));
    this.addKnownServer(url);
  },
  get() {
    try {
      const val = localStorage.getItem(ServerURLStorageKEY);

      return JSON.parse(val as string);
    } catch (e) {
      return undefined;
    }
  },
  addKnownServer(url: string) {
    if (!url) return;
    try {
      const urlObj = new URL(url);
      const origin = urlObj.origin;
      const known = this.getKnownServers();
      if (!known.includes(origin)) {
        localStorage.setItem(KnownServersKEY, JSON.stringify([...known, origin]));
      }
    } catch (e) {
      // Not a valid URL, ignore
    }
  },
  getKnownServers(): string[] {
    try {
      const val = localStorage.getItem(KnownServersKEY);
      if (!val) return [];
      return JSON.parse(val);
    } catch (e) {
      return [];
    }
  },
  removeKnownServer(url: string) {
    const known = this.getKnownServers();
    localStorage.setItem(KnownServersKEY, JSON.stringify(known.filter(s => s !== url)));
  }
};
