// @wc-ignore-file
import { core, Datatype, type Store } from '@tomic/lib';
import {
  assertPrivateWebsiteParent,
  readWebsite,
  saveWebsiteResource,
  type WebsiteConfig,
} from './websiteModel';

export interface WebsiteField {
  subject: string;
  property: string;
  label: string;
  original: string;
}

/** Only explicit text fields of a selected row may be written from the preview. */
export async function commitWebsiteField(
  store: Store,
  project: string,
  field: WebsiteField,
  value: string,
) {
  const site = await store.getResource(project);
  const { config } = await readWebsite(store, store.getDrive()!, site);
  const binding = config.pages
    .flatMap(page => page.tables)
    .find(
      table =>
        table.rows.includes(field.subject) &&
        table.columns.some(column => column.property === field.property),
    );
  if (!binding)
    throw new Error('This field is no longer selected for the website.');
  const resource = await store.getResource(field.subject);
  const agent = store.getAgent();
  if (!agent || !(await resource.canWrite(agent.subject)))
    throw new Error('You cannot edit this content.');
  if (resource.get(core.properties.parent) !== binding.table)
    throw new Error('This row no longer belongs to the selected table.');
  await assertPrivateWebsiteParent(store, field.subject);
  const property = await store.getResource(field.property);
  if (property.get(core.properties.datatype) !== Datatype.STRING)
    throw new Error('Use the record editor for this field type.');
  if ((resource.get(field.property) ?? '') !== field.original)
    throw new Error(
      'This field changed since the preview opened. Refresh the preview before editing it.',
    );
  await resource.set(field.property, value);
  await saveWebsiteResource(resource);
}

/** Positions correspond to our closed static renderer, never to arbitrary site HTML. */
export function pageFields(page: WebsiteConfig['pages'][number]) {
  return page.tables.flatMap((table, tableIndex) =>
    table.rows.flatMap((subject, rowIndex) =>
      table.columns.map((column, columnIndex) => ({
        subject,
        property: column.property,
        label: column.label,
        tableIndex,
        rowIndex,
        columnIndex,
        layout: table.layout,
      })),
    ),
  );
}
