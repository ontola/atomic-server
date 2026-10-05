// @wc-ignore-file
import { Datatype, type SchemaSpec } from '@tomic/lib';

/**
 * The vocabulary for split pieces: table views, integrations and lenses.
 *
 * Kept out of `pluginSchema()` on purpose while this is an exploration: it is
 * only minted when someone seeds the demo, so drives that never opt in carry
 * none of it. A view and an integration are both drive Apps (`pluginSchema`'s
 * `app` class) with `renders` naming the row classes they accept natively;
 * `piece-kind` is the only thing that tells them apart.
 */
export function piecesSchema(): SchemaSpec {
  return {
    properties: [
      {
        shortname: 'piece-kind',
        name: 'Piece kind',
        description:
          '"view" renders a table\'s rows; "integration" syncs them with an external platform and shows the sync state instead. Apps without it are views.',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'piece-provider',
        name: 'Provider',
        description:
          'The external platform an integration syncs with, e.g. "clockify".',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'lens-source',
        name: 'Source class',
        description: 'The row class this lens reads from.',
        datatype: Datatype.ATOMIC_URL,
      },
      {
        shortname: 'lens-target',
        name: 'Target class',
        description: 'The row class this lens produces.',
        datatype: Datatype.ATOMIC_URL,
      },
      {
        shortname: 'lens-mapping',
        name: 'Mapping',
        description:
          'The declarative lens: which source property becomes which target property, and through which converter. See chunks/Pieces/lens.ts.',
        datatype: Datatype.JSON,
      },
      {
        shortname: 'synced-table',
        name: 'Synced table',
        description: 'The table an integration binding syncs.',
        datatype: Datatype.ATOMIC_URL,
      },
      {
        shortname: 'sync-state',
        name: 'Sync state',
        description:
          'Connected account, last sync and the outbox (pending, held, failed, uncertain and blocked writes, with conflicts) of one integration on one table.',
        datatype: Datatype.JSON,
      },
    ],
    classes: [
      {
        shortname: 'lens',
        name: 'Lens',
        description:
          'A declarative, two-way translation between two row classes. A view or integration written for the target class can then be offered on tables of the source class, and the other way round.',
        requires: ['lens-source', 'lens-target', 'lens-mapping'],
      },
      {
        shortname: 'sync-binding',
        name: 'Sync binding',
        description:
          'One integration installed on one table: which table, through which lenses, and its sync state. Lives under the integration app, which is where the app may write.',
        requires: ['synced-table'],
        recommends: ['sync-state'],
      },
    ],
  };
}
