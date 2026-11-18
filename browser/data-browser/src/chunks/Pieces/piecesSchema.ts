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
        shortname: 'lens-review',
        name: 'Review',
        description:
          '"approved" once someone has reviewed this drive-local lens. Until then it offers nothing: integrations it would reach show as waiting for review. Lenses from the shared catalog need no review here.',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'lens-review-digest',
        name: 'Reviewed content',
        description:
          'The digest ("sha256:…") of the source, target and mapping that were approved. The lens is trusted only while its current content has this digest, so any edit needs a new review.',
        datatype: Datatype.STRING,
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
          'A drive-local, declarative, two-way translation between two row classes. Once approved, an integration written for one class can be offered on tables of the other. Shared lenses live in the catalog next to the ontology instead.',
        requires: ['lens-source', 'lens-target', 'lens-mapping'],
        recommends: ['lens-review', 'lens-review-digest'],
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
