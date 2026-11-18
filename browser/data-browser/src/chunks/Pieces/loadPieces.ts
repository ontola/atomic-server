// @wc-ignore-file
import {
  CollectionBuilder,
  core,
  findSchema,
  pluginSchema,
  type Store,
} from '@tomic/lib';
import type { DriveApp } from '@chunks/AppPage/useDriveApps';
import { piecesSchema } from './piecesSchema';
import { parseMapping, storedMapping, type LensMapping } from './lens';
import { loadLensCatalog } from './lensCatalog';
import { reviewApproves } from './lensReview';
import {
  offersForTable,
  type LensInfo,
  type Offer,
  type PieceInfo,
} from './offers';

export interface StoredLens extends LensInfo {
  mapping: LensMapping;
  /** Where the lens comes from: the shared catalog, or this drive. */
  origin: 'catalog' | 'drive';
}

export interface DrivePieces {
  pieces: PieceInfo[];
  lenses: StoredLens[];
}

/**
 * The pinned catalog's lenses as offers see them. Catalog lenses were
 * reviewed where they were published, so they are trusted on every drive.
 * None while the split-pieces flag is off, and none (with a warning) when the
 * release cannot be read.
 */
export async function loadCatalogLenses(): Promise<StoredLens[]> {
  return (await loadLensCatalog()).map(lens => ({
    subject: lens.subject,
    name: lens.name,
    source: lens.source,
    target: lens.target,
    mapping: lens.mapping,
    trusted: true,
    origin: 'catalog',
  }));
}

/**
 * The drive's lenses, and each app read as a piece. Apps without a
 * `piece-kind` are views, so every app that exists today keeps working.
 *
 * A lens whose mapping does not parse is left out rather than failing the
 * menu: one broken lens should not hide every other offer.
 */
export async function loadPieces(
  store: Store,
  drive: string,
  apps: DriveApp[],
): Promise<DrivePieces> {
  const schema = await findSchema(store, drive, piecesSchema());
  const kindProp = schema.properties?.['piece-kind'];

  const pieces = await Promise.all(
    apps.map(async (app): Promise<PieceInfo> => {
      const kind = kindProp
        ? (await store.getResource(app.subject)).get(kindProp)
        : undefined;

      return { ...app, kind: kind === 'integration' ? 'integration' : 'view' };
    }),
  );

  const catalog = await loadCatalogLenses();

  const lensClass = schema.classes?.lens;
  const props = schema.properties ?? {};

  if (
    !lensClass ||
    !props['lens-source'] ||
    !props['lens-target'] ||
    !props['lens-mapping']
  ) {
    return { pieces, lenses: catalog };
  }

  const subjects = await new CollectionBuilder(store)
    .setProperty(core.properties.isA)
    .setValue(lensClass)
    .setPageSize(100)
    .build()
    .getAllMembers();

  const lenses: StoredLens[] = [...catalog];

  for (const subject of subjects) {
    const resource = await store.getResource(subject);

    try {
      const source = resource.get(props['lens-source']) as string;
      const target = resource.get(props['lens-target']) as string;
      const stored = resource.get(props['lens-mapping']);
      // Plain data (not the parsed form, which holds functions), so it can
      // be handed to a frame in `lensPath`.
      const mapping = storedMapping(parseMapping(stored));

      lenses.push({
        subject,
        name: resource.title,
        source,
        target,
        mapping,
        // A drive-local lens offers nothing until someone approves it, and
        // stays approved only while its content is what was approved.
        trusted:
          !!props['lens-review'] &&
          !!props['lens-review-digest'] &&
          (await reviewApproves(
            resource.get(props['lens-review']),
            resource.get(props['lens-review-digest']),
            { source, target, mapping: stored },
          )),
        origin: 'drive',
      });
    } catch (e) {
      console.warn(`Skipping lens ${subject}:`, e);
    }
  }

  return { pieces, lenses };
}

export interface LensRoute {
  /** The chain the frame reads rows through. Empty for a native match. */
  lensPath: {
    subject: string;
    name: string;
    direction: string;
    mapping: LensMapping;
  }[];
  /**
   * Names of unreviewed lenses that hold this integration back on this
   * table. When non-empty the frame gets no path and must not sync.
   */
  pendingReview: string[];
}

/**
 * How an integration reaches `rowClass`'s table, for the integration's frame:
 * the chain of lenses with their mappings, or the unreviewed lenses that are
 * in the way.
 */
export async function lensRouteFor(
  store: Store,
  drive: string,
  app: string,
  rowClass: string | undefined,
): Promise<LensRoute> {
  const resource = await store.getResource(app);
  const { pieces, lenses } = await loadPieces(store, drive, [
    {
      subject: app,
      name: resource.title,
      renders: await rendersOf(store, drive, app),
    },
  ]);
  const offer: Offer | undefined = offersForTable(pieces, lenses, rowClass)[0];
  const named = (subject: string) => lenses.find(l => l.subject === subject)!;

  if (!offer) return { lensPath: [], pendingReview: [] };

  if (offer.pendingReview.length > 0) {
    return {
      lensPath: [],
      pendingReview: offer.pendingReview.map(s => named(s).name),
    };
  }

  return {
    lensPath: offer.path.map(step => {
      const lens = named(step.lens);

      return {
        subject: lens.subject,
        name: lens.name,
        direction: step.direction,
        mapping: lens.mapping,
      };
    }),
    pendingReview: [],
  };
}

async function rendersOf(store: Store, drive: string, app: string) {
  const schema = await findSchema(store, drive, pluginSchema());
  const prop = schema.properties?.renders;
  const value = prop ? (await store.getResource(app)).get(prop) : undefined;

  return Array.isArray(value)
    ? value.filter((c): c is string => typeof c === 'string')
    : [];
}
