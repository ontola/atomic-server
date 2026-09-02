import { describe, it } from 'vitest';
import { Client } from './client.js';
import { Store } from './store.js';

const HOME = 'http://localhost:9883';

describe('Client.isBareHttpOrigin / isHttpDriveSubject', () => {
  it('treats a host with no path as a server origin', ({ expect }) => {
    expect(Client.isBareHttpOrigin('https://atomicdata.dev')).toBe(true);
    expect(Client.isBareHttpOrigin('https://atomicdata.dev/')).toBe(true);
    expect(Client.isBareHttpOrigin('http://localhost:9883')).toBe(true);
    expect(Client.isHttpDriveSubject('https://atomicdata.dev')).toBe(false);
  });

  it('treats an HTTP URL with a path as a drive subject', ({ expect }) => {
    expect(Client.isHttpDriveSubject('https://atomicdata.dev/drives/foo')).toBe(
      true,
    );
    expect(Client.isBareHttpOrigin('https://atomicdata.dev/drives/foo')).toBe(
      false,
    );
  });

  it('does not treat DIDs as either', ({ expect }) => {
    expect(Client.isBareHttpOrigin('did:ad:abc')).toBe(false);
    expect(Client.isHttpDriveSubject('did:ad:abc')).toBe(false);
  });
});

describe('Store.setDrive does not move the home server for an HTTP drive', () => {
  it('keeps serverUrl when opening a foreign HTTP drive', ({ expect }) => {
    const store = new Store({ serverUrl: HOME });
    store.setDrive('https://atomicdata.dev/drives/legacy');

    expect(store.getServerUrl()).toBe(HOME);
    expect(store.getDrive()).toBe('https://atomicdata.dev/drives/legacy');
    expect(store.isForeignOriginSubject(store.getDrive()!)).toBe(true);
    expect(store.isLiveSyncedDrive(store.getDrive()!)).toBe(false);
  });

  it('keeps serverUrl when opening a same-origin HTTP drive', ({ expect }) => {
    const store = new Store({ serverUrl: HOME });
    store.setDrive(`${HOME}/drives/on-this-node`);

    expect(store.getServerUrl()).toBe(HOME);
    expect(store.getDrive()).toBe(`${HOME}/drives/on-this-node`);
    expect(store.isLiveSyncedDrive(store.getDrive()!)).toBe(true);
  });

  it('does not move the server for a DID drive', ({ expect }) => {
    const store = new Store({ serverUrl: HOME });
    store.setDrive('did:ad:personal');

    expect(store.getServerUrl()).toBe(HOME);
    expect(store.getDrive()).toBe('did:ad:personal');
    expect(store.isLiveSyncedDrive('did:ad:personal')).toBe(true);
  });

  it('treats a bare origin as setServerUrl, not as a drive', ({ expect }) => {
    const store = new Store({ serverUrl: HOME });
    store.setDrive('did:ad:personal');
    store.setDrive('https://atomicdata.dev');

    expect(store.getServerUrl()).toBe('https://atomicdata.dev');
    expect(store.getDrive()).toBe('did:ad:personal');
  });

  it('clears the drive on an empty string', ({ expect }) => {
    const store = new Store({ serverUrl: HOME });
    store.setDrive('did:ad:personal');
    store.setDrive('');

    expect(store.getDrive()).toBeUndefined();
    expect(store.getServerUrl()).toBe(HOME);
  });
});
