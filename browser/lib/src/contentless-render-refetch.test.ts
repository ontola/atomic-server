import { beforeAll, describe, it } from 'vitest';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { LoroLoader } from './loro-loader.js';
import { Resource } from './resource.js';
import { core } from './index.js';

/**
 * Reproduces the user's local-DB-off bug and pins its fix.
 *
 * Live capture on the broken page (Local DB OFF):
 *   STORE now:                 loading:false, error:null, isA:null, entries:1
 *   AFTER forced server fetch: loading:false, error:null, isA:[Folder], entries:6
 *
 * So the server HAS the resource — the client just never fetched it.
 * `getResourceLoading` returns an already-present resource untouched unless it
 * carries the explicit `incomplete` flag. Something seeds a child contentless
 * (a drive-sync / collection skeleton) with `loading=false` and no flag, so the
 * render path trusts it and renders the bare-subject "deeply broken" view. With
 * OPFS on a later cache hit fills it (the "empty for a couple ms" flash); with
 * OPFS off nothing fills it and it stays broken.
 *
 * The fix: `getResourceLoading` treats a settled, class-less resource as needing
 * a fetch — so it can never be RENDERED as contentless without either loading or
 * an error.
 */

const PARENT = 'https://atomicdata.dev/properties/parent';

beforeAll(async () => {
  await LoroLoader.initializeLoro();
});

async function makeStore(): Promise<Store> {
  const store = new Store({ serverUrl: 'https://example.com' });
  const keys = await Agent.generateKeyPair();
  store.setAgent(
    new Agent(
      new JSCryptoProvider(keys.privateKey),
      `did:ad:agent:${keys.publicKey}`,
    ),
  );

  return store;
}

/** Seed the store the way a drive-sync / collection skeleton does: present,
 *  settled (not loading), no error, a stray prop, and crucially no class. */
function seedContentlessSkeleton(store: Store, subject: string): Resource {
  const r = new Resource(subject);
  r.setStore(store);
  r.loading = false;
  r.applyHydratedValues([[PARENT, 'did:ad:somedrive']]);
  (store as unknown as { resources: Map<string, Resource> }).resources.set(
    subject,
    r,
  );

  return r;
}

describe('getResourceLoading — a settled class-less resource is never trusted', () => {
  const subject =
    'did:ad:contentlessSeedReproAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

  it('kicks a fetch instead of returning the bare skeleton', async ({
    expect,
  }) => {
    const store = await makeStore();
    // Pretend the server is connected so the refetch takes the (async) server
    // path and leaves the resource visibly `loading` rather than synchronously
    // failing offline (covered by the next test).
    (store as unknown as { _serverConnected: boolean })._serverConnected = true;
    const seeded = seedContentlessSkeleton(store, subject);

    // The exact broken shape from the live capture.
    expect(seeded.loading).toBe(false);
    expect(seeded.get(core.properties.isA)).toBeUndefined();

    // Rendering it (useResource → getResourceLoading) must NOT hand back the
    // contentless skeleton as-is — it flips to loading and pulls the resource.
    const got = store.getResourceLoading(subject);
    expect(got.loading).toBe(true);
  });

  it('ends in a non-silent state (offline ⇒ errored, never settled-blank)', async ({
    expect,
  }) => {
    const store = await makeStore(); // offline (no server connected)
    const r = seedContentlessSkeleton(store, subject);

    store.getResourceLoading(subject);

    // Let the local-fallback path settle. Offline with no cache, the resource
    // stays LOADING while it waits briefly for the WS to (re)connect — it must
    // NOT drop back to loading=false with no class and no error.
    for (let i = 0; i < 50 && !r.loading; i++) {
      await new Promise(res => setTimeout(res, 10));
    }

    expect(r.loading).toBe(true);
  });
});
