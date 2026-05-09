/**
 * Microbenchmarks for the WS-UPDATE → React-render hot path. Each suite
 * targets one bottleneck identified in `PERFORMANCE_PLAN.md`; if these
 * regress unexpectedly, one of the perf wins shipped on the DID/WS
 * branch has likely been undone.
 *
 * Run with `pnpm bench` (in `browser/lib`). The output is order-of-
 * magnitude — runner variance is significant — so the regressions
 * worth tracking are *factor* changes (≥2× slower), not single-percent
 * drift.
 */
import { bench, beforeAll, describe } from 'vitest';

import { Collection } from './collection.js';
import { enableLoro } from './loro-loader.js';
import { proxyResource, Resource } from './resource.js';
import { Store } from './store.js';
import { collections } from './ontologies/collections.js';
import { core } from './ontologies/core.js';

await enableLoro();

// --- shared helpers -------------------------------------------------------

function makeStore(): Store {
  return new Store({ serverUrl: 'https://example.com' });
}

function makeResource(
  subject: string,
  props: Record<string, unknown> = {
    [core.properties.name]: 'A resource',
  },
  lastCommit = 'did:ad:commit:base',
): Resource {
  const r = new Resource(subject);
  for (const [k, v] of Object.entries(props)) {
    // applyHydratedValues bypasses validation + commit machinery, just
    // populates the cache + Loro doc — closest analogue to a freshly
    // hydrated resource arriving from the WS UPDATE path.
    r.applyHydratedValues([[k, v as never]]);
  }
  // Stamp a lastCommit so the addResource gate has something to compare.
  r.applyHydratedValues([
    ['https://atomicdata.dev/properties/lastCommit', lastCommit as never],
  ]);
  r.loading = false;
  return r;
}

// --- 1. Resource read paths (called per render) ---------------------------

describe('Resource.get / .title (per-render hot path)', () => {
  const r = makeResource('https://example.com/a', {
    [core.properties.name]: 'My Resource',
    [core.properties.shortname]: 'res',
    [core.properties.description]: 'description',
  });

  bench('Resource.get(name) — cache hit', () => {
    r.get(core.properties.name);
  });

  bench('Resource.title getter — falls through to .name', () => {
    void r.title;
  });

  bench('Resource.loading getter — already loaded', () => {
    void r.loading;
  });
});

// --- 2. Resource.merge (called on every WS UPDATE) ------------------------

describe('Resource.merge (WS UPDATE path)', () => {
  // Fresh source/target pair for each iteration would be too expensive to
  // construct inside the loop and would dominate the measurement. We
  // measure merge() on pre-built resources; benchmark interprets results
  // accordingly (i.e. compare across these benches, don't read absolute
  // numbers).
  const target = makeResource('https://example.com/m', {
    [core.properties.name]: 'Initial',
  });
  const source = makeResource(
    'https://example.com/m',
    { [core.properties.name]: 'Updated' },
    'did:ad:commit:newer',
  );

  bench('merge — incoming change, rebuild cache', () => {
    target.merge(source);
  });
});

// --- 3. Store.addResource gating -----------------------------------------

describe('Store.addResource (commit-compare gate)', () => {
  const store = makeStore();
  const subject = 'https://example.com/gated';
  // Pre-add a resource so subsequent calls hit the merge/skip path.
  store.addResource(makeResource(subject), { skipCommitCompare: true });

  bench('addResource — same lastCommit (gate skips notify)', () => {
    // Same lastCommit → store gate returns early without merge or notify.
    const next = makeResource(subject);
    store.addResource(next);
  });

  bench('addResource — skipCommitCompare:true (forced merge + notify)', () => {
    const next = makeResource(subject, { [core.properties.name]: 'Forced' });
    store.addResource(next, { skipCommitCompare: true });
  });
});

// --- 4. Store.notify fan-out ---------------------------------------------

describe('Store.notify fan-out (subscriber chain)', () => {
  const store = makeStore();
  const subject = 'https://example.com/fanout';
  const r = makeResource(subject);
  store.addResource(r, { skipCommitCompare: true });

  // Subscribe N callbacks for the same subject — represents N mounted
  // useResource calls all watching the same resource.
  const N = 50;
  for (let i = 0; i < N; i++) {
    store.subscribe(subject, () => undefined);
  }

  bench(`addResource → notify with ${N} subject subscribers`, () => {
    const next = makeResource(subject, { [core.properties.name]: 'Notify' });
    store.addResource(next, { skipCommitCompare: true });
  });
});

// --- 5. Collection.applyResourceChange (listener fan-out) ----------------

describe('Collection.applyResourceChange (B2: indexed lookup)', () => {
  const store = makeStore();
  // Build a collection page with 200 members so the *old* indexOf cost
  // would have shown up linearly. The new Set-indexed lookup should be
  // O(1) regardless.
  const PAGE_SIZE = 200;
  const memberSubjects = Array.from(
    { length: PAGE_SIZE },
    (_, i) => `https://example.com/member-${i}`,
  );
  for (const m of memberSubjects) {
    store.addResource(
      makeResource(m, {
        [core.properties.parent]: 'https://example.com/parent',
      }),
      { skipCommitCompare: true },
    );
  }
  const collection = new Collection(
    store,
    'https://example.com',
    {
      property: core.properties.parent,
      value: 'https://example.com/parent',
      page_size: String(PAGE_SIZE),
      include_nested: false,
    },
    /* noFetch */ true,
  );
  // Hydrate page 0 directly — bypassing the normal /query path so the
  // bench focuses on applyResourceChange, not collection setup.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pageRes = new Resource((collection as any).buildSubject(0));
  pageRes.applyHydratedValues([
    [collections.properties.members, memberSubjects],
    [collections.properties.totalMembers, memberSubjects.length],
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (collection as any).setPage(0, pageRes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (collection as any)._totalMembers = memberSubjects.length;

  // Unrelated subject: not in the index, no member churn — the fast path.
  // Pre-B2 this scanned every page on every event.
  const unrelated = makeResource('https://example.com/unrelated', {
    [core.properties.parent]: 'https://example.com/other-parent',
  });

  bench('applyResourceChange — unrelated subject (fast bail)', () => {
    collection.applyResourceChange(unrelated.subject, unrelated);
  });

  // Existing member with no change to filter property — the index says
  // it's a member, but `matches` is also true → no churn.
  const memberStill = store.resources.get(memberSubjects[100])!;
  bench('applyResourceChange — member that still matches', () => {
    collection.applyResourceChange(memberStill.subject, memberStill);
  });
});

// --- 6. proxyResource allocation -----------------------------------------

describe('proxyResource (B1: every notify path)', () => {
  const r = makeResource('https://example.com/proxy');

  bench('proxyResource(r) — Proxy allocation', () => {
    proxyResource(r);
  });
});
