// @wc-ignore-file
import { canonicalizeScheme } from '@tomic/lib';

/** Account pointers are discovery hints, never resource access grants. */
export type CatalogEntry = {
  drive_subject: string;
  drive_name?: string | null;
  drive_emoji?: string | null;
};
export type DriveCatalog = { drives: CatalogEntry[]; removed: string[] };
export type CatalogIdentity = { email: string; agent: string };
export type CatalogSnapshot = DriveCatalog & CatalogIdentity;

export function catalogSubjects(
  local: string[],
  catalog: DriveCatalog | null,
): string[] {
  // Compared by canonical spelling: one drive can arrive as `did:ad:` from
  // one list and `atomic:` from the other, and was then listed twice.
  const removed = new Set((catalog?.removed ?? []).map(canonicalizeScheme));
  const seen = new Set<string>();

  return [
    ...local,
    ...(catalog?.drives.map(d => d.drive_subject) ?? []),
  ].filter(subject => {
    const key = canonicalizeScheme(subject);

    if (removed.has(key) || seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

export function parseCatalog(value: unknown): DriveCatalog {
  const c = value as DriveCatalog;

  if (
    !c ||
    !Array.isArray(c.drives) ||
    !Array.isArray(c.removed) ||
    c.drives.some(d => typeof d?.drive_subject !== 'string') ||
    c.removed.some(d => typeof d !== 'string')
  ) {
    throw new Error('Invalid drive catalog');
  }

  return c;
}

/**
 * Every mounted drive list (the sidebar's switcher, the account page) reports
 * the same catalog on mount, on focus and every 30 s. A report identical to
 * the last one, sent less than `ttlMs` ago or still in flight, shares its
 * answer instead of posting again. A failed report is not shared.
 * `expire()` drops an answer that already arrived, for a refresh the user or
 * the network asked for (focus, back online): those must reach the server,
 * while a report still in flight keeps being shared.
 */
export function shareCatalogReports<T>(
  post: (body: string) => Promise<T>,
  ttlMs = 25_000,
) {
  let last:
    | { key: string; at: number; result: Promise<T>; settled: boolean }
    | undefined;

  return {
    send(key: string, body: string): Promise<T> {
      if (last?.key === key && Date.now() - last.at < ttlMs) return last.result;

      const entry = { key, at: Date.now(), result: post(body), settled: false };
      last = entry;
      entry.result.then(
        () => {
          entry.settled = true;
        },
        () => {
          entry.settled = true;
          if (last === entry) last = undefined;
        },
      );

      return entry.result;
    },
    expire() {
      if (last?.settled) last = undefined;
    },
    reset() {
      last = undefined;
    },
  };
}

export class DriveCatalogSync {
  private generation = 0;
  snapshot: CatalogSnapshot | null = null;
  constructor(
    private deps: {
      identity: () => Promise<CatalogIdentity | null>;
      send: (entries: CatalogEntry[]) => Promise<unknown>;
      changed: (snapshot: CatalogSnapshot | null) => void;
    },
  ) {}

  reset() {
    this.generation++;
    this.snapshot = null;
    this.deps.changed(null);
  }

  async refresh(entries: CatalogEntry[]) {
    const request = ++this.generation;
    const identity = await this.deps.identity();
    if (request !== this.generation) return;

    if (!identity) {
      this.reset();

      return;
    }

    if (
      this.snapshot &&
      (this.snapshot.email !== identity.email ||
        this.snapshot.agent !== identity.agent)
    ) {
      this.snapshot = null;
      this.deps.changed(null);
    }

    const result = parseCatalog(await this.deps.send(entries));
    if (request !== this.generation) return;
    const after = await this.deps.identity();
    if (request !== this.generation) return;

    if (
      !after ||
      after.email !== identity.email ||
      after.agent !== identity.agent
    ) {
      this.reset();

      return;
    }

    this.snapshot = { ...result, ...identity };
    this.deps.changed(this.snapshot);
  }
}

export function catalogCacheKey(identity: CatalogIdentity): string {
  return `atomic-drive-catalog:${JSON.stringify([identity.email, identity.agent])}`;
}

export function readCatalogCache(
  identity: CatalogIdentity,
  storage: Pick<Storage, 'getItem'>,
): CatalogSnapshot | null {
  try {
    const raw = storage.getItem(catalogCacheKey(identity));
    if (!raw) return null;

    return { ...parseCatalog(JSON.parse(raw)), ...identity };
  } catch {
    return null;
  }
}
