import { beforeAll, describe, it } from 'vitest';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { LoroLoader } from './loro-loader.js';
import { Resource } from './resource.js';
import { commits, core } from './index.js';

/**
 * The live channel is deltas, and nothing in it can say "you are missing
 * something". A receiver that misses one update parks it as pending and every
 * later update parks behind it — no error, no indicator, the document just
 * quietly stops being live until someone reloads.
 *
 * Measured in the field: two paired nodes, same document open, one side typed
 * `awdawdawad oawdinawiodawoi dn` and the other kept showing `awd`, with the
 * sender's cursor still blinking in it the whole time. A reload pulled the full
 * text immediately, so the server had it throughout.
 *
 * What made it silent rather than loud: an unappliable delta on a resource that
 * already had content fell through to "applied", stamping `lastCommit` for a
 * commit that was never applied.
 */

const NAME = 'https://atomicdata.dev/properties/name';

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

/** Build the exact shape of the field failure: a seed the receiver has, a
 *  commit it never receives, and then a delta that depends on that missing
 *  commit. Exporting a fresh doc as `update` does NOT reproduce this — with no
 *  prior version it carries every op from the start and applies cleanly. The
 *  gap only exists if the delta is exported `from` a version the receiver
 *  never reached. */
function withheldCommit(): { seed: Uint8Array; orphaned: Uint8Array[] } {
  const { LoroDoc } = LoroLoader.Loro;
  const doc = new LoroDoc();
  const map = doc.getMap('properties');

  map.set(core.properties.isA, [core.classes.document]);
  map.set(NAME, 'awd');
  doc.commit();
  const seed = doc.export({ mode: 'snapshot' });

  // The update that goes missing on the wire.
  map.set(NAME, 'the delta that never arrived');
  doc.commit();
  const missed = doc.version();

  // Everything after it depends on it, so none of it can apply.
  const orphaned: Uint8Array[] = [];

  for (const text of [
    'awdawdawad oawdinawiodawoi dn',
    'aw',
    'd',
    'more',
    'and more',
  ]) {
    map.set(NAME, text);
    doc.commit();
    orphaned.push(
      doc.export({ mode: 'update', from: missed } as never) as Uint8Array,
    );
  }

  return { seed, orphaned };
}

describe('a delta that cannot apply triggers a catch-up fetch', () => {
  const subject = 'did:ad:gapRecoveryReproAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

  /** Seed a resource with real, usable content — the case the old code let
   *  through silently, because a resource with an `isA` was assumed healthy. */
  async function seeded(
    store: Store,
  ): Promise<{ orphaned: Uint8Array[] }> {
    const { seed, orphaned } = withheldCommit();
    const r = new Resource(subject);
    r.setStore(store);
    r.loading = true;
    store.applyIncoming({
      subject,
      loroBytes: seed,
      source: 'ws-pending-get',
      replaceLoroDocsFromRemote: true,
    });

    return { orphaned };
  }

  it('asks the server for full state instead of reporting success', async ({
    expect,
  }) => {
    const store = await makeStore();
    const { orphaned } = await seeded(store);

    const asked: string[] = [];

    (
      store as unknown as {
        fetchResourceFromServer: (s: string, o?: unknown) => Promise<Resource>;
      }
    ).fetchResourceFromServer = async (s: string) => {
      asked.push(s);

      return store.resources.get(s)!;
    };

    const outcome = store.applyIncoming({
      subject,
      loroBytes: orphaned[0],
      commitId: 'did:ad:commit:neverApplied',
      source: 'ws-sub-push',
    });

    expect(outcome).not.toBe('applied');
    expect(asked).toEqual([subject]);
  });

  it('does not claim a commit it never applied', async ({ expect }) => {
    const store = await makeStore();
    const { orphaned } = await seeded(store);

    (
      store as unknown as { fetchResourceFromServer: () => Promise<unknown> }
    ).fetchResourceFromServer = async () => undefined;

    store.applyIncoming({
      subject,
      loroBytes: orphaned[0],
      commitId: 'did:ad:commit:neverApplied',
      source: 'ws-sub-push',
    });

    // Stamping it would make the echo-dedup at the top of `applyIncoming`
    // drop the very fetch issued to repair the gap — the fix would then be
    // a no-op that still looks like it works.
    const resource = store.resources.get(subject)!;
    expect(resource.get(commits.properties.lastCommit)).not.toBe(
      'did:ad:commit:neverApplied',
    );
  });

  it('keeps the content it already had rather than blanking the document', async ({
    expect,
  }) => {
    const store = await makeStore();
    const { orphaned } = await seeded(store);

    (
      store as unknown as { fetchResourceFromServer: () => Promise<unknown> }
    ).fetchResourceFromServer = async () => undefined;

    store.applyIncoming({
      subject,
      loroBytes: orphaned[0],
      commitId: 'did:ad:commit:neverApplied',
      source: 'ws-sub-push',
    });

    // Failing the resource outright would be the other way to be loud about
    // this, and it would throw away a document the user can still read.
    const resource = store.resources.get(subject)!;
    expect(resource.get(NAME)).toBe('awd');
    expect(resource.error).toBeUndefined();
  });

  it('fires one catch-up fetch for a burst of unappliable deltas', async ({
    expect,
  }) => {
    const store = await makeStore();
    const { orphaned } = await seeded(store);

    let pending: (() => void) | undefined;
    let calls = 0;

    (
      store as unknown as { fetchResourceFromServer: () => Promise<unknown> }
    ).fetchResourceFromServer = () => {
      calls++;

      return new Promise(resolve => {
        pending = () => resolve(undefined);
      });
    };

    // Every later delta parks behind the first missing one, so they arrive as
    // a burst. One repair fetch is enough for all of them.
    orphaned.forEach((bytes, i) => {
      store.applyIncoming({
        subject,
        loroBytes: bytes,
        commitId: `did:ad:commit:burst${i}`,
        source: 'ws-sub-push',
      });
    });

    expect(calls).toBe(1);

    pending?.();
  });
});
