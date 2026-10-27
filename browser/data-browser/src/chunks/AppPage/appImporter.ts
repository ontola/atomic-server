// @wc-ignore-file
import {
  destinationOwnerOf,
  findSchema,
  pluginSchema,
  pluginConfigFor,
  pluginConfigProblems,
  type Store,
  type PluginManifest,
  type JSONObject,
  type ApplyReport,
  type RunPlan,
} from '@tomic/react';
import type { ImporterFile, ImporterRunResult } from '@tomic/plugin';
import { checkSize, type ImportUpload } from '@chunks/PluginRuns/importFile';

/** The importer an app may run, resolved and checked by the host. */
export interface AppImporter {
  importer: string;
  title: string;
  source: string;
  manifest: PluginManifest;
  config: JSONObject;
  /** The file the app handed over, checked; absent when the person picks one. */
  upload?: ImportUpload;
}

export const NO_IMPORTER =
  "This app has no importer to run. It can run one only while it is shown as a view of the importer's table.";
export const FOREIGN_IMPORTER =
  'This app may only run its own importer: the one that created the table it shows.';

/**
 * Which importer `store.importer.run()` may start, or why none.
 *
 * The app never chooses. The host resolves the importer from the table the
 * app is a view of: the plugin whose Set up created that table and still
 * names it in its config. An app on its own page, or on a table no importer
 * made, has none. An app naming a different importer is refused, so a view
 * cannot reach a plugin of another package through this op.
 *
 * Nothing here writes or runs anything: running happens after the person has
 * agreed, and writing only after they approved the review.
 */
export async function resolveAppImporter(
  store: Store,
  drive: string,
  table: string | undefined,
  request: { file?: unknown; importer?: unknown },
  describe: (source: string) => Promise<PluginManifest>,
): Promise<AppImporter> {
  if (!table) throw new Error(NO_IMPORTER);
  const importer = await destinationOwnerOf(store, drive, table);
  if (!importer) throw new Error(NO_IMPORTER);

  if (request.importer !== undefined && request.importer !== importer)
    throw new Error(FOREIGN_IMPORTER);

  const schema = await findSchema(store, drive, pluginSchema());
  const resource = await store.getResource(importer);

  const read = (name: string) => {
    const property = schema.properties?.[name];

    return property ? resource.get(property) : undefined;
  };

  const source = read('plugin-source');
  if (typeof source !== 'string' || !source) throw new Error(NO_IMPORTER);

  const manifest = await describe(source);
  if (!manifest.accepts?.length)
    throw new Error("This app's importer does not take files.");

  const config = pluginConfigFor(
    { schemas: read('plugin-schemas'), connection: read('plugin-connection') },
    manifest.config,
  );
  if (pluginConfigProblems(config, manifest.config).length > 0)
    throw new Error(
      'This importer needs Set up first. Open it and choose Set up.',
    );

  const upload =
    request.file === undefined ? undefined : appFile(request.file, manifest);

  return {
    importer,
    title: resource.title,
    source,
    manifest,
    config,
    ...(upload ? { upload } : {}),
  };
}

/** A file the app handed over: well-formed, and no larger than accepted. */
function appFile(file: unknown, manifest: PluginManifest): ImportUpload {
  const f = file as (Partial<ImporterFile> & { base64?: unknown }) | null;

  if (f && typeof f === 'object' && f.base64 !== undefined) {
    throw new Error(
      'This host supports text imports only; binary uploads are not supported.',
    );
  }

  if (
    !f ||
    typeof f !== 'object' ||
    typeof f.name !== 'string' ||
    !f.name ||
    typeof f.text !== 'string' ||
    (f.mediaType !== undefined && typeof f.mediaType !== 'string')
  )
    throw new Error('file must be { name, mediaType?, text }');

  const size = new TextEncoder().encode(f.text).length;
  checkSize(size, manifest.accepts ?? []);

  return { name: f.name, mediaType: f.mediaType ?? '', size, text: f.text };
}

/**
 * What the app is told once the person is done: counts, not rows. The app
 * reads the rows themselves through its table, as it always does.
 */
export function importerRunSummary(
  importer: string,
  outcome:
    | { report: ApplyReport; plan: RunPlan }
    | { plan?: RunPlan; error?: string },
): ImporterRunResult {
  if ('report' in outcome) {
    const applied = outcome.report.outcomes.filter(o => o.status === 'applied');
    const failed = outcome.report.outcomes.filter(o => o.status === 'failed');

    return {
      status: 'applied',
      importer,
      created: applied.filter(o => o.op === 'create').length,
      // Distinct subjects: a set and a remove on one row are one update.
      updated: new Set(
        applied
          .filter(o => o.op === 'set' || o.op === 'remove')
          .map(o => o.subject),
      ).size,
      destroyed: applied.filter(o => o.op === 'destroy').length,
      failed: failed.length,
      errors: failed.map(
        o => o.error ?? /* @wc-ignore */ `Could not ${o.op} ${o.subject}`,
      ),
    };
  }

  if (outcome.error)
    return { status: 'blocked', importer, errors: [outcome.error] };

  const { plan } = outcome;

  if (plan?.blocked)
    return {
      status: 'blocked',
      importer,
      errors: [
        ...plan.problems,
        ...plan.changes.flatMap(change => change.problems),
      ]
        .filter(problem => problem.severity === 'error')
        .map(problem => problem.message),
    };

  if (plan && plan.changes.length === 0) return { status: 'nothing', importer };

  return { status: 'cancelled', importer };
}
