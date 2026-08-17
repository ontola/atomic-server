import { describe, it } from 'vitest';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { LoroLoader } from './loro-loader.js';
import { Resource } from './resource.js';
import { core, commits } from './index.js';

/** The WS/HTTP ordering: something renders the subject first, so a loading
 *  placeholder is in the store before the server's bytes arrive. */
function seedLoadingPlaceholder(store: Store, subject: string): Resource {
  const r = new Resource(subject);
  r.setStore(store);
  r.loading = true;
  (store as unknown as { resources: Map<string, Resource> }).resources.set(
    subject,
    r,
  );

  return r;
}

/** `markDirty` is a no-op while offline, and the whole point here is what the
 *  outbox does, so the store has to believe it is connected. */
function pretendConnected(store: Store): void {
  (store as unknown as { _serverConnected: boolean })._serverConnected = true;
}

/**
 * Stand-in for what the server sends back: a Loro snapshot plus the JSON-AD
 * propvals alongside it. `createdBy` is the interesting one — the server
 * derives it from the genesis certificate and ships it as a propval, but it is
 * NOT in the snapshot, because nobody ever wrote it there.
 */
function serverResource(subject: string, name: string): Resource {
  const { LoroDoc } = LoroLoader.Loro;
  const doc = new LoroDoc();
  const props = doc.getMap('properties');
  props.set(core.properties.isA, ['https://atomicdata.dev/classes/Drive']);
  props.set(core.properties.name, name);
  doc.commit();

  const incoming = new Resource(subject);
  incoming.applyHydratedValues([
    [core.properties.isA, ['https://atomicdata.dev/classes/Drive']],
    [core.properties.name, name],
    ['https://atomicdata.dev/properties/createdBy', 'did:ad:agent:someone'],
    [commits.properties.loroUpdate, doc.export({ mode: 'snapshot' })],
  ]);

  return incoming;
}

/**
 * Reading someone else's resource must not queue a write to it.
 *
 * Field bug (2026-08-17): right after accepting a VIEW invite, the invitee's
 * client signed a commit against the shared drive and the server refused it —
 * correctly, they have no write right. The commit carried the drive's entire
 * contents, which is what a Loro export from an empty version vector looks
 * like: the drive's doc had been hydrated through operations that count as
 * LOCAL, and the outbox dutifully tried to push them. The invitee, who had
 * written nothing, was left with a blocked queue entry and a permanent
 * "changes pending".
 *
 * The dirty filter (`isOwnedSubject`) only asks whether a subject belongs to
 * our server, never whether we may write it — so the guard has to be that
 * hydrating from the server produces no local operations in the first place.
 */
describe('hydrating a fetched resource', () => {
  /**
   * The path that produced the bug. `JSONADParser` fills the cache from the
   * JSON-AD and then calls `getLoroDoc()`, whose heal pass writes every cached
   * key the snapshot lacks into the document — `createdBy` among them, because
   * the server derives it and never stores it there.
   */
  it('keeps a server-derived propval out of the document', async ({
    expect,
  }) => {
    await LoroLoader.initializeLoro();

    const incoming = serverResource('did:ad:whatever', 'Their Drive');
    const props = incoming.getLoroDoc()?.getMap('properties');

    expect(props?.get(core.properties.name)).toBe('Their Drive');
    expect(
      props?.get('https://atomicdata.dev/properties/createdBy'),
    ).toBeUndefined();
    // Still readable — it lives in the cache.
    expect(incoming.get('https://atomicdata.dev/properties/createdBy')).toBe(
      'did:ad:agent:someone',
    );
  });

  it('does not mark a subject dirty when the server hydrates it', async ({
    expect,
  }) => {
    await LoroLoader.initializeLoro();

    const store = new Store({ serverUrl: 'https://example.com' });
    const keys = await Agent.generateKeyPair();
    store.setAgent(
      new Agent(
        new JSCryptoProvider(keys.privateKey),
        `did:ad:agent:${keys.publicKey}`,
      ),
    );
    pretendConnected(store);

    const subject = 'did:ad:someone-elses-drive';
    seedLoadingPlaceholder(store, subject);

    store.applyIncoming({
      subject,
      resource: serverResource(subject, 'Their Drive'),
      source: 'http-fetch',
    });

    const hydrated = store.getResourceLoading(subject);

    expect(hydrated.get(core.properties.name)).toBe('Their Drive');
    // The load-bearing assertion: a propval the server derived must not have
    // become an operation in our copy of the document. Everything else here
    // is downstream of that.
    expect(
      hydrated
        .getLoroDoc()
        ?.getMap('properties')
        .get('https://atomicdata.dev/properties/createdBy'),
    ).toBeUndefined();
    // The derived propval still reads back — it just lives in the cache
    // rather than in the CRDT.
    expect(hydrated.get('https://atomicdata.dev/properties/createdBy')).toBe(
      'did:ad:agent:someone',
    );
    expect(store.outbox.hasPending(subject)).toBe(false);
  });
});
