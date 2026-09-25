import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import {
  installRelease,
  saveInstallationConfig,
  updateInstallationRelease,
  withdrawRouteWriteRights,
} from './plugin-install.js';
import type { DeclaredWriteTarget } from './plugin-manifest-http.js';
import {
  UnresolvedWriteTargetError,
  capabilityGrantNames,
  grantsWithRouteWrites,
  newWriteTargets,
  routeGrantOf,
  routeWriteConfigChange,
} from './plugin-route-grant.js';
import type { Store } from './store.js';
import { testStore } from './test-store.js';

/** #1754's fixture: one target, `inbox-items` under `config:inbox`. */
const INBOX_MANIFEST = JSON.parse(
  readFileSync(
    new URL(
      '../../../testdata/plugin-routes/inbox/manifest.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const TARGETS: DeclaredWriteTarget[] = INBOX_MANIFEST.http.writeTargets;
/** What the page must write; the server's `a_page_shaped_install_stores_a_post` installs it. */
const PAGE_INSTALL = JSON.parse(
  readFileSync(
    new URL(
      '../../../testdata/plugin-routes/inbox/page-install.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const PLUGIN_AGENT = 'did:ad:agent:plugin-agent-key';
const OTHER_WRITER = 'did:ad:agent:someone-else';

/** The server adds `pluginAgent` when it serves an installed Installation. */
function serveAgent(store: Store) {
  return vi.spyOn(store, 'fetchResourceFromServer').mockResolvedValue({
    get: (prop: string) =>
      prop === server.properties.pluginAgent ? PLUGIN_AGENT : undefined,
  } as never);
}

async function driveWithInbox(store: Store) {
  const drive = await store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: { [core.properties.name]: 'Team' },
  });
  await drive.save();
  const inbox = await store.newResource({
    parent: drive.subject,
    propVals: {
      [core.properties.name]: 'Inbox',
      [core.properties.write]: [OTHER_WRITER],
    },
  });
  await inbox.save();

  return { drive: drive.subject, inbox: inbox.subject };
}

const RELEASE = {
  url: 'https://example.com/releases/blake3:inbox',
  id: 'blake3:inbox',
};

function writers(store: Store, subject: string): string[] {
  return (store.getResourceLoading(subject).get(core.properties.write) ??
    []) as string[];
}

describe('the route grant', () => {
  it('is an object element next to the capability names, with the targets unchanged', () => {
    expect(grantsWithRouteWrites(['storage'], TARGETS)).toEqual([
      'storage',
      {
        'route-writes': [
          {
            id: 'inbox-items',
            parent: 'config:inbox',
            classes: ['https://atomicdata.dev/classes/PlainText'],
          },
        ],
      },
    ]);
    expect(grantsWithRouteWrites(['storage'], undefined)).toEqual(['storage']);
  });

  it('is read back from either form the server accepts', () => {
    const array = grantsWithRouteWrites(['storage'], TARGETS);
    expect(routeGrantOf(array)).toEqual(TARGETS);
    expect(routeGrantOf(JSON.stringify(array))).toEqual(TARGETS);
    expect(routeGrantOf({ storage: true, 'route-writes': TARGETS })).toEqual(
      TARGETS,
    );
    expect(routeGrantOf(['storage'])).toBeUndefined();
    expect(capabilityGrantNames(array)).toEqual(['storage']);
    expect(
      capabilityGrantNames({ storage: true, 'route-writes': TARGETS }),
    ).toEqual(['storage']);
  });

  it('counts a target with another parent or more classes as new', () => {
    expect(newWriteTargets(TARGETS, TARGETS)).toEqual([]);
    expect(newWriteTargets(TARGETS, undefined)).toEqual(TARGETS);
    const wider = [
      { ...TARGETS[0], classes: [...TARGETS[0].classes, 'https://x/C'] },
    ];
    expect(newWriteTargets(wider, TARGETS)).toEqual(wider);
    const narrower = [{ ...TARGETS[0], classes: [] }];
    expect(newWriteTargets(TARGETS, narrower)).toEqual(TARGETS);
  });
});

describe('installing with route writes', () => {
  it('writes the route grant and lets the plugin agent write the inbox, signed by the installer', async () => {
    const { store, posted, agentDID } = await testStore();
    const { drive, inbox } = await driveWithInbox(store);
    const fetchAgent = serveAgent(store);

    const subject = await installRelease(store, {
      drive,
      release: RELEASE,
      name: 'inbox',
      namespace: 'fixtures',
      config: { inbox },
      grants: ['storage'],
      routeWrites: TARGETS,
    });

    const installation = store.getResourceLoading(subject);
    expect(installation.get(server.properties.grants)).toEqual([
      'storage',
      { 'route-writes': TARGETS },
    ]);
    expect(installation.get(server.properties.grants)).toEqual(
      PAGE_INSTALL.grants,
    );
    expect(core.properties.write).toBe(PAGE_INSTALL.rights.property);
    expect(fetchAgent).toHaveBeenCalledWith(subject, { noWebSocket: true });

    // The rights commit: the installer adds the plugin agent to the inbox's
    // `write`, next to whoever could already write there.
    expect(writers(store, inbox)).toEqual([OTHER_WRITER, PLUGIN_AGENT]);
    const rights = posted.filter(c => c.subject === inbox);
    expect(rights.length).toBe(2); // the inbox's genesis, then the grant
    expect(rights[1].signer).toBe(agentDID);
    expect(posted.at(-1)?.subject).toBe(inbox);
  });

  it('refuses to install when a target names a config key that is not set', async () => {
    const { store, posted } = await testStore();
    const { drive } = await driveWithInbox(store);
    const before = posted.length;

    await expect(
      installRelease(store, {
        drive,
        release: RELEASE,
        name: 'inbox',
        config: { somethingElse: 'x' },
        grants: ['storage'],
        routeWrites: TARGETS,
      }),
    ).rejects.toThrow(UnresolvedWriteTargetError);
    await expect(
      installRelease(store, {
        drive,
        release: RELEASE,
        name: 'inbox',
        config: { inbox: '' },
        grants: ['storage'],
        routeWrites: TARGETS,
      }),
    ).rejects.toThrow(/"inbox-items".*"inbox", which is not set/);
    expect(posted.length).toBe(before);
  });

  it('without approval writes no route grant and gives no rights', async () => {
    const { store } = await testStore();
    const { drive, inbox } = await driveWithInbox(store);
    const fetchAgent = serveAgent(store);

    const subject = await installRelease(store, {
      drive,
      release: RELEASE,
      name: 'inbox',
      config: { inbox },
      grants: ['storage'],
    });

    expect(
      store.getResourceLoading(subject).get(server.properties.grants),
    ).toEqual(['storage']);
    expect(fetchAgent).not.toHaveBeenCalled();
    expect(writers(store, inbox)).toEqual([OTHER_WRITER]);
  });
});

describe('revoking route writes', () => {
  it('takes the plugin agent off the inbox and leaves other writers', async () => {
    const { store, posted, agentDID } = await testStore();
    const { drive, inbox } = await driveWithInbox(store);
    serveAgent(store);
    const subject = await installRelease(store, {
      drive,
      release: RELEASE,
      name: 'inbox',
      config: { inbox },
      grants: ['storage'],
      routeWrites: TARGETS,
    });
    expect(writers(store, inbox)).toContain(PLUGIN_AGENT);
    const before = posted.length;

    await withdrawRouteWriteRights(store, subject);

    expect(writers(store, inbox)).toEqual([OTHER_WRITER]);
    const commits = posted.slice(before);
    expect(commits.map(c => c.subject)).toEqual([inbox]);
    expect(commits[0].signer).toBe(agentDID);
  });

  it('does nothing for an installation without a route grant', async () => {
    const { store, posted } = await testStore();
    const { drive, inbox } = await driveWithInbox(store);
    const fetchAgent = serveAgent(store);
    const subject = await installRelease(store, {
      drive,
      release: RELEASE,
      name: 'inbox',
      config: { inbox },
      grants: ['storage'],
    });
    const before = posted.length;

    await withdrawRouteWriteRights(store, subject);

    expect(posted.length).toBe(before);
    expect(fetchAgent).not.toHaveBeenCalled();
  });
});

describe('a config change that moves a write target', () => {
  async function installed() {
    const t = await testStore();
    const { drive, inbox } = await driveWithInbox(t.store);
    const fetchAgent = serveAgent(t.store);
    const subject = await installRelease(t.store, {
      drive,
      release: RELEASE,
      name: 'inbox',
      config: { inbox },
      grants: ['storage'],
      routeWrites: TARGETS,
    });
    const elsewhere = await t.store.newResource({
      parent: drive,
      propVals: { [core.properties.name]: 'Elsewhere' },
    });
    await elsewhere.save();
    fetchAgent.mockClear();

    return { ...t, subject, inbox, elsewhere: elsewhere.subject, fetchAgent };
  }

  it('is detected, and only when a resolved parent changes', () => {
    const grants = grantsWithRouteWrites(['storage'], TARGETS);

    expect(
      routeWriteConfigChange(grants, { inbox: 'a' }, { inbox: 'b' }),
    ).toEqual({ targets: TARGETS, moved: TARGETS });
    // A config stored as a JSON string reads the same.
    expect(
      routeWriteConfigChange(grants, JSON.stringify({ inbox: 'a' }), {
        inbox: 'b',
      })?.moved,
    ).toEqual(TARGETS);
    expect(
      routeWriteConfigChange(grants, { inbox: 'a' }, { inbox: 'a', x: 1 }),
    ).toBeUndefined();
    expect(
      routeWriteConfigChange(['storage'], { inbox: 'a' }, { inbox: 'b' }),
    ).toBeUndefined();
    expect(() =>
      routeWriteConfigChange(grants, { inbox: 'a' }, { inbox: '' }),
    ).toThrow(UnresolvedWriteTargetError);
  });

  it('moves the plugin agent’s write to the new parent when approved', async () => {
    const { store, posted, agentDID, subject, inbox, elsewhere } =
      await installed();
    const before = posted.length;

    await saveInstallationConfig(store, subject, {
      config: { inbox: elsewhere },
      previousConfig: { inbox },
      approveRouteWrites: true,
    });

    const installation = store.getResourceLoading(subject);
    const config = installation.get(server.properties.config);
    expect(typeof config === 'string' ? JSON.parse(config) : config).toEqual({
      inbox: elsewhere,
    });
    expect(routeGrantOf(installation.get(server.properties.grants))).toEqual(
      TARGETS,
    );
    expect(writers(store, elsewhere)).toEqual([PLUGIN_AGENT]);
    expect(writers(store, inbox)).toEqual([OTHER_WRITER]);
    // The Installation, then the new parent's grant, then the old one's
    // withdrawal, all signed by the installer.
    const commits = posted.slice(before);
    expect(commits.map(c => c.subject)).toEqual([subject, elsewhere, inbox]);
    expect(commits.every(c => c.signer === agentDID)).toBe(true);
  });

  it('drops the route grant and the rights when the approval is declined', async () => {
    const { store, posted, subject, inbox, elsewhere } = await installed();
    const before = posted.length;

    await saveInstallationConfig(store, subject, {
      config: { inbox: elsewhere },
      previousConfig: { inbox },
      approveRouteWrites: false,
    });

    const installation = store.getResourceLoading(subject);
    expect(installation.get(server.properties.grants)).toEqual(['storage']);
    expect(writers(store, inbox)).toEqual([OTHER_WRITER]);
    expect(writers(store, elsewhere)).toEqual([]);
    expect(posted.slice(before).map(c => c.subject)).toEqual([subject, inbox]);
  });

  it('refuses a config that leaves a target unresolved, committing nothing', async () => {
    const { store, posted, subject, inbox, fetchAgent } = await installed();
    const before = posted.length;

    await expect(
      saveInstallationConfig(store, subject, {
        config: { inbox: '' },
        previousConfig: { inbox },
        approveRouteWrites: true,
      }),
    ).rejects.toThrow(UnresolvedWriteTargetError);
    expect(posted.length).toBe(before);
    expect(fetchAgent).not.toHaveBeenCalled();
    expect(writers(store, inbox)).toContain(PLUGIN_AGENT);
  });

  it('just saves the config when no target moves', async () => {
    const { store, posted, subject, inbox, fetchAgent } = await installed();
    const before = posted.length;

    await saveInstallationConfig(store, subject, {
      config: { inbox, note: 'hi' },
      previousConfig: { inbox },
      approveRouteWrites: true,
    });

    expect(posted.slice(before).map(c => c.subject)).toEqual([subject]);
    expect(fetchAgent).not.toHaveBeenCalled();
    expect(writers(store, inbox)).toContain(PLUGIN_AGENT);
  });
});

describe('upgrading with route writes', () => {
  it('replaces the grant with the widened targets and gives rights on the new parent', async () => {
    const { store } = await testStore();
    const { drive, inbox } = await driveWithInbox(store);
    serveAgent(store);
    const subject = await installRelease(store, {
      drive,
      release: RELEASE,
      name: 'inbox',
      config: { inbox },
      grants: ['storage'],
      routeWrites: TARGETS,
    });
    const archive = await store.newResource({
      parent: drive,
      propVals: { [core.properties.name]: 'Archive' },
    });
    await archive.save();
    const widened: DeclaredWriteTarget[] = [
      ...TARGETS,
      {
        id: 'archive',
        parent: 'config:archive',
        classes: ['https://atomicdata.dev/classes/PlainText'],
      },
    ];

    await updateInstallationRelease(store, subject, {
      release: { url: 'https://example.com/releases/blake3:two', id: 'b:2' },
      grants: ['storage'],
      routeWrites: widened,
      config: { inbox, archive: archive.subject },
    });

    expect(
      routeGrantOf(
        store.getResourceLoading(subject).get(server.properties.grants),
      ),
    ).toEqual(widened);
    expect(writers(store, inbox)).toContain(PLUGIN_AGENT);
    expect(writers(store, archive.subject)).toEqual([PLUGIN_AGENT]);

    // Declining the next review's targets drops the grant and the rights.
    await updateInstallationRelease(store, subject, {
      release: { url: 'https://example.com/releases/blake3:3', id: 'b:3' },
      grants: ['storage'],
    });
    expect(
      store.getResourceLoading(subject).get(server.properties.grants),
    ).toEqual(['storage']);
    expect(writers(store, inbox)).toEqual([OTHER_WRITER]);
    expect(writers(store, archive.subject)).toEqual([]);
  });
});
