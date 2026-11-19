import { core, dataBrowser, type Resource, type Store } from '@tomic/react';
import type { AtomicViewWriteContext } from './atomicViewWrite';
import {
  readAtomicTableViewConfiguration,
  writeAtomicTableViewConfiguration,
} from './atomicViewConfiguration';
import {
  type ConfiguredColumnEdit,
  prepareConfiguredColumn,
  mergeConfiguredColumn,
  effectiveConfiguredColumns,
} from './configuredColumnDraft';
import { ROW_ACTION_GENERATORS, isRowActionComplete } from './rowActions';
import { isFormulaProperty } from './derivedColumns';
import { validateFormula } from './formulaEngine';

/** Mutation body for the existing serial view-write service. It rechecks target
 * metadata on every attempt; checkpoints retain only the accepted draft identity. */
export async function writeAtomicConfiguredColumn(
  store: Store,
  table: string,
  owner: string,
  view: Resource,
  edit: ConfiguredColumnEdit,
  intent: AtomicViewWriteContext,
) {
  const source = await store.getResource(table);
  if (source.get(core.properties.classtype) !== owner)
    throw Error('The table row class changed. Close the editor and reopen it.');
  const cls = await store.getResource(owner);
  const declared = new Set([
    ...cls.getArray(core.properties.requires),
    ...cls.getArray(core.properties.recommends),
  ]);
  const dependencies =
    edit.kind === 'action'
      ? [edit.candidate.property]
      : Object.values(edit.candidate.vars);

  if (
    edit.kind === 'computed' &&
    edit.implicit &&
    view.get(dataBrowser.properties.viewDerivedColumns) === undefined
  ) {
    for (const spec of edit.implicit.specs)
      dependencies.push(...Object.values(spec.vars));
  }

  for (const id of new Set(dependencies)) {
    if (!declared.has(id))
      throw Error(
        'A referenced column is no longer in the row class. Close the editor and reopen it.',
      );
    const property = await store.getProperty(id);
    if (
      edit.kind === 'action'
        ? !ROW_ACTION_GENERATORS[edit.candidate.kind]?.accepts(property)
        : !isFormulaProperty(property)
    )
      throw Error(
        'A referenced column has an incompatible datatype. Close the editor and reopen it.',
      );
  }

  if (edit.kind === 'action' && !isRowActionComplete(edit.candidate))
    throw Error('Complete the action before saving.');

  if (edit.kind === 'computed') {
    const problem = validateFormula({
      kind: 'formula',
      formula: edit.candidate.formula,
      vars: edit.candidate.vars,
    });
    if (problem !== null)
      throw Error(problem ?? 'The formula engine is unavailable.');
  }

  const field = edit.kind === 'action' ? 'rowActions' : 'derivedColumns';

  const readCurrent = () => {
    const read = readAtomicTableViewConfiguration(view);
    if (read.issues.some(issue => issue.field === field))
      throw Error(
        'The saved column configuration is invalid. Repair it before saving.',
      );

    if (edit.kind === 'computed')
      read.config.derivedColumns = effectiveConfiguredColumns(
        read.config.derivedColumns,
        view.get(dataBrowser.properties.viewDerivedColumns) !== undefined,
        JSON.stringify([
          read.config.kind,
          read.config.groupBy ?? null,
          read.config.endProp ?? null,
        ]),
        edit.implicit,
      );

    return read.config;
  };

  const current = readCurrent();

  if (edit.kind === 'action') {
    const desired = await intent.checkpoint('configured-column', async () =>
      prepareConfiguredColumn(
        current.rowActions,
        edit.candidate,
        edit.original,
      ),
    );
    const rowActions = mergeConfiguredColumn(
      readCurrent().rowActions,
      desired,
      edit.original,
    );
    intent.beforeMutation();
    await writeAtomicTableViewConfiguration(view, { rowActions });
  } else {
    const desired = await intent.checkpoint('configured-column', async () =>
      prepareConfiguredColumn(
        current.derivedColumns,
        edit.candidate,
        edit.original,
      ),
    );
    const derivedColumns = mergeConfiguredColumn(
      readCurrent().derivedColumns,
      desired,
      edit.original,
    );
    intent.beforeMutation();
    await writeAtomicTableViewConfiguration(view, { derivedColumns });
  }
}
