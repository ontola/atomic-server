import type { Property } from '@tomic/react';
import type { TableViewWriteReceipt } from '@tomic/table';

export interface ConfiguredColumnDialogDraft<T> {
  initial?: T;
  properties: Property[];
  values: Map<string, T>;
  receipt?: TableViewWriteReceipt;
}
export async function saveConfiguredColumnDraft<T>(
  draft: ConfiguredColumnDialogDraft<T>,
  submit: (value: T) => TableViewWriteReceipt,
) {
  const candidate = draft.values.get('candidate');
  if (!candidate)
    throw Error('Complete the column configuration before saving.');
  draft.receipt ??= submit(structuredClone(candidate));
  await draft.receipt.retry();
}
