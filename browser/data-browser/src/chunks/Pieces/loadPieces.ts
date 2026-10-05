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
import { parseLensMapping, type LensMapping } from './lens';
import {
  offersForTable,
  type LensInfo,
  type Offer,
  type PieceInfo,
} from './offers';

export interface StoredLens extends LensInfo {
  mapping: LensMapping;
}

export interface DrivePieces {
  pieces: PieceInfo[];
  lenses: StoredLens[];
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

  const lensClass = schema.classes?.lens;
  const props = schema.properties ?? {};

  if (
    !lensClass ||
    !props['lens-source'] ||
    !props['lens-target'] ||
    !props['lens-mapping']
  ) {
    return { pieces, lenses: [] };
  }

  const subjects = await new CollectionBuilder(store)
    .setProperty(core.properties.isA)
    .setValue(lensClass)
    .setPageSize(100)
    .build()
    .getAllMembers();

  const lenses: StoredLens[] = [];

  for (const subject of subjects) {
    const resource = await store.getResource(subject);

    try {
      lenses.push({
        subject,
        name: resource.title,
        source: resource.get(props['lens-source']) as string,
        target: resource.get(props['lens-target']) as string,
        mapping: parseLensMapping(resource.get(props['lens-mapping'])),
      });
    } catch (e) {
      console.warn(`Skipping lens ${subject}:`, e);
    }
  }

  return { pieces, lenses };
}

/**
 * The lens chain an integration was offered through on `table`, with each
 * lens's mapping, for the integration's frame. Empty for a native match or
 * when the app is not offered there at all.
 */
export async function lensPathFor(
  store: Store,
  drive: string,
  app: string,
  rowClass: string | undefined,
): Promise<
  { subject: string; name: string; direction: string; mapping: LensMapping }[]
> {
  const resource = await store.getResource(app);
  const { pieces, lenses } = await loadPieces(store, drive, [
    {
      subject: app,
      name: resource.title,
      renders: await rendersOf(store, drive, app),
    },
  ]);
  const offer: Offer | undefined = offersForTable(pieces, lenses, rowClass)[0];

  if (!offer) return [];

  return offer.path.map(step => {
    const lens = lenses.find(l => l.subject === step.lens)!;

    return {
      subject: lens.subject,
      name: lens.name,
      direction: step.direction,
      mapping: lens.mapping,
    };
  });
}

async function rendersOf(store: Store, drive: string, app: string) {
  const schema = await findSchema(store, drive, pluginSchema());
  const prop = schema.properties?.renders;
  const value = prop ? (await store.getResource(app)).get(prop) : undefined;

  return Array.isArray(value)
    ? value.filter((c): c is string => typeof c === 'string')
    : [];
}
