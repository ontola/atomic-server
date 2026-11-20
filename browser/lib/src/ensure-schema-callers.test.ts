import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// `ensureSchema` gives every drive its own property IDs. A term that more than
// one drive or app must understand belongs in a fixed namespace instead.
const remaining = [
  'browser/data-browser/src/chunks/PluginRuns/CreateEventAutomation.tsx',
  'browser/data-browser/src/chunks/PluginRuns/runScript.ts',
  'browser/lib/src/catalog-app.ts',
  'browser/lib/src/plugin-app.ts',
  'browser/lib/src/plugin-destination.ts',
  'browser/lib/src/plugin-log.ts',
  'browser/lib/src/plugin-schema.ts',
  'browser/table-page/src/TablePage/createTableFromSpec.ts',
];

it('does not gain new ensureSchema callers', () => {
  const root = new URL('../../../', import.meta.url);
  const callers = [
    'browser/lib/src',
    'browser/data-browser/src',
    'browser/ui/src',
    'browser/table/src',
    'browser/resource-ui/src',
    'browser/table-page/src',
  ]
    .flatMap(dir =>
      readdirSync(new URL(dir, root), {
        recursive: true,
        encoding: 'utf8',
      }).map(file => `${dir}/${file}`),
    )
    .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter(file =>
      readFileSync(new URL(file, root), 'utf8').includes('ensureSchema('),
    )
    .sort();

  // New features define their terms in a fixed namespace (`lib/defaults`, see
  // `shared-vocabularies.ts`). This list may only shrink.
  expect(
    callers,
    'New features define their terms in a fixed namespace (lib/defaults); this list may only shrink.',
  ).toEqual(remaining);
});
