import { useTableRowResource } from './useTableRowResource';
import { TableRowSelectCheckbox, type IndexedTableRows } from '@tomic/table';
import { useContext, type JSX } from 'react';
import { unknownSubject } from '@tomic/react';
import { TablePageContext } from './tablePageContext';

type RowSelectCheckboxProps = { index: number } & (
  | { collection: IndexedTableRows; subject?: undefined }
  | { subject: string; collection?: undefined }
);

/**
 * The tick box in a row's header cell. Hidden until the row is hovered, unless
 * a row is already ticked: then every row shows one ("select mode").
 *
 * Give it the row's `subject` when the caller already knows it (rows added this
 * session); otherwise the subject is looked up in the `collection` by `index`.
 */
export function RowSelectCheckbox(
  props: RowSelectCheckboxProps,
): JSX.Element | null {
  return props.collection ? (
    <CollectionRowCheckbox collection={props.collection} index={props.index} />
  ) : (
    <SubjectCheckbox subject={props.subject} index={props.index} />
  );
}

function CollectionRowCheckbox({
  collection,
  index,
}: {
  collection: IndexedTableRows;
  index: number;
}): JSX.Element | null {
  const { subject } = useTableRowResource(collection, index);

  return subject === unknownSubject ? null : (
    <SubjectCheckbox subject={subject} index={index} />
  );
}

function SubjectCheckbox({
  subject,
  index,
}: {
  subject: string;
  index: number;
}): JSX.Element {
  const { selectedRows, toggleRowSelected } = useContext(TablePageContext);

  return (
    <TableRowSelectCheckbox
      checked={selectedRows.has(subject)}
      selectionActive={selectedRows.size > 0}
      label={`Select row ${index + 1}`}
      onToggle={() => toggleRowSelected(subject)}
    />
  );
}
