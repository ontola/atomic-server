import { describe, it } from 'vitest';
import { server } from './ontologies/server.js';
import { testStore } from './test-store.js';

/**
 * The product minted a fresh "My drive" on each sign-in. Derivation itself is
 * stable (see `subtle-private-drive.test.ts`), so the churn has to come from
 * the path around it: a second call that does not recognise the drive the
 * first one made.
 */
describe('ensurePrivateDrive is idempotent', () => {
  it('returns the same subject when called twice', async ({ expect }) => {
    const { store } = await testStore();

    const first = await store.ensurePrivateDrive();
    const second = await store.ensurePrivateDrive();

    expect(second.subject).toBe(first.subject);
  });

  it('returns the same subject after the in-memory cache is dropped', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const first = await store.ensurePrivateDrive();

    // What a reload looks like: same key, same store config, nothing cached.
    (
      store as unknown as { _resources: Map<string, unknown> }
    )._resources.clear();

    const second = await store.ensurePrivateDrive();

    expect(second.subject).toBe(first.subject);
  });

  it('does not accumulate drives on the list when called repeatedly', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const first = await store.ensurePrivateDrive();
    await store.ensurePrivateDrive();
    const third = await store.ensurePrivateDrive();

    const listed = third.getSubjects(server.properties.drives);
    const own = listed.filter(s => s === first.subject);

    expect(own.length).toBeLessThanOrEqual(1);
  });

  it('migrates once per agent even when setAgent fires repeatedly', async ({
    expect,
  }) => {
    const { store, agentDID } = await testStore();
    const agent = store.getAgent()!;

    agent.legacySubject = 'https://atomicdata.dev/agents/QmExample=';

    let fetches = 0;
    const internals = store as unknown as {
      adoptLegacyAgentIdentity: (a: unknown) => Promise<void>;
      fetchLegacyAgentResource: (s: string) => Promise<undefined>;
    };

    internals.fetchLegacyAgentResource = async () => {
      fetches++;

      return undefined;
    };

    // Booting sets an agent more than once; each pass used to migrate again.
    await Promise.all([
      internals.adoptLegacyAgentIdentity(agent),
      internals.adoptLegacyAgentIdentity(agent),
    ]);
    await internals.adoptLegacyAgentIdentity(agent);

    expect(fetches).toBe(1);
    expect(agentDID).toBeTruthy();
  });
});
