import {
  core,
  dataBrowser,
  Datatype,
  type Store,
  type Resource,
} from '@tomic/react';
import type { QuickAddSpec } from '@tomic/table';
import type { AtomicViewWriteContext } from './atomicViewWrite';
import { canonicalJson } from './canonicalJson';
import {
  readAtomicTableViewConfiguration,
  writeAtomicTableViewConfiguration,
} from './atomicViewConfiguration';
import { ROW_ACTION_GENERATORS, isRowActionComplete } from './rowActions';

/** Recheck the captured create-button intent and merge only its metadata field. */
export async function writeAtomicQuickAddConfiguration(
  store: Store,
  table: string,
  owner: string,
  view: Resource,
  original: QuickAddSpec | undefined,
  desired: QuickAddSpec | undefined,
  intent: AtomicViewWriteContext,
) {
  const source = await store.getResource(table);
  if (source.get(core.properties.classtype) !== owner)
    throw Error(
      'The table row class changed. Close this editor and reopen it.',
    );
  const cls = await store.getResource(owner);
  const declared = new Set([
    ...cls.getArray(core.properties.requires),
    ...cls.getArray(core.properties.recommends),
  ]);

  if (desired) {
    if (!desired.label.trim()) throw Error('Enter a create-button label.');

    if (desired.field) {
      const field = await store.getProperty(desired.field);
      if (
        (!declared.has(desired.field) &&
          desired.field !== core.properties.name) ||
        ![Datatype.STRING, Datatype.SLUG].includes(field.datatype)
      )
        throw Error('The typing column is unavailable or incompatible.');
    }

    for (const preset of desired.presets ?? []) {
      const generator = ROW_ACTION_GENERATORS[preset.kind];
      if (!generator || !declared.has(preset.property))
        throw Error('A preset column is no longer available.');
      const property = await store.getProperty(preset.property);
      if (
        preset.kind === 'setValue' &&
        property.allowsOnly?.length &&
        !property.allowsOnly.includes(String(preset.value))
      )
        throw Error('A preset option is no longer available.');
      if (
        !generator.accepts(property) ||
        !isRowActionComplete({
          id: 'quick-add',
          label: desired.label,
          ...preset,
          ...(preset.kind === 'increment' && preset.value === undefined
            ? { value: 1 }
            : {}),
        })
      )
        throw Error('A preset is incomplete or its column is incompatible.');
    }
  }

  const read = readAtomicTableViewConfiguration(view);
  if (
    view.get(dataBrowser.properties.viewQuickAdd) !== undefined &&
    !read.config.quickAdd
  )
    throw Error(
      'The saved create-button configuration is invalid. Repair it before saving.',
    );
  const current = canonicalJson(JSON.stringify(read.config.quickAdd ?? null));
  if (
    current !== canonicalJson(JSON.stringify(original ?? null)) &&
    current !== canonicalJson(JSON.stringify(desired ?? null))
  )
    throw Error(
      'The create button changed elsewhere. Close this editor and reopen it.',
    );
  intent.beforeMutation();
  await writeAtomicTableViewConfiguration(view, { quickAdd: desired });
}
