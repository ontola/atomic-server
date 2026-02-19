import {
  commits,
  JSONValue,
  Property,
  useDebouncedSave,
  useResource,
  useValue,
} from '@tomic/react';
import { useCallback, useContext, useMemo, type JSX } from 'react';
import { Cell } from '@chunks/TableEditor';
import { CellAlign } from '@chunks/TableEditor/Cell';
import {
  CursorMode,
  useTableEditorContext,
} from '@chunks/TableEditor/TableEditorContext';
import {
  appendStringToType,
  dataTypeAlignmentMap,
  dataTypeCellMap,
} from './dataTypeMaps';
import { StringCell } from './EditorCells/StringCell';
import { TablePageContext } from './tablePageContext';
import { createValueChangedHistoryItem } from './helpers/useTableHistory';

interface TableCellProps {
  columnIndex: number;
  rowIndex: number;
  subject: string;
  property: Property;
  onEditNextRow?: () => void;
}

const SAVE_DEBOUNCE_TIME = 200;

function useIsEditing(row: number, column: number) {
  const { cursorMode, selectedColumn, selectedRow } = useTableEditorContext();

  const isEditing =
    cursorMode === CursorMode.Edit &&
    selectedColumn === column &&
    selectedRow === row;

  return isEditing;
}

const valueOpts = {
  commitDebounce: 0,
  commit: false,
  validate: false,
};

const emptyFunc = () => undefined;

export function TableCell({
  columnIndex,
  rowIndex,
  subject,
  property,
  onEditNextRow,
}: TableCellProps): JSX.Element {
  const resource = useResource(subject, {
    track: [property.subject],
  });
  const { setActiveCell } = useTableEditorContext();
  const { addItemsToHistoryStack } = useContext(TablePageContext);
  // We give an empty error handler to debouncedSave so it doesn't spam the user with error popups when the value is invalid.
  const [save, savePending] = useDebouncedSave(
    resource,
    SAVE_DEBOUNCE_TIME,
    emptyFunc,
  );
  const [value, setValue] = useValue(resource, property.subject, valueOpts);

  const [createdAt, setCreatedAt] = useValue(
    resource,
    commits.properties.createdAt,
    { commit: false, commitDebounce: 0 },
  );

  const dataType = property.datatype;
  const isEditing = useIsEditing(rowIndex, columnIndex);

  const Editor = useMemo(
    () => dataTypeCellMap.get(dataType) ?? StringCell,
    [dataType],
  );

  const alignment = dataTypeAlignmentMap.get(dataType) ?? CellAlign.Start;

  const onChange = useCallback(
    async (v: JSONValue) => {
      if (!createdAt) {
        await setCreatedAt(Date.now());
      }

      addItemsToHistoryStack(
        createValueChangedHistoryItem(resource, property.subject),
      );

      await setValue(v);

      save();
    },
    [
      setValue,
      setCreatedAt,
      createdAt,
      resource,
      property.subject,
      save,
      addItemsToHistoryStack,
    ],
  );

  const handleEnterEditModeWithCharacter = useCallback(
    (key: string) => {
      onChange(appendStringToType(undefined, key, dataType));
    },
    [onChange, dataType],
  );

  const propValCount = resource.getPropVals().size;

  const handleEditNextRow = useCallback(() => {
    if (!savePending) {
      onEditNextRow?.();

      // Only go to the next row if the resource has any properties set (It has two by default, isA and parent)
      // This prevents triggering a rerender and losing focus on the input.
      if (propValCount > 2) {
        setActiveCell(rowIndex + 1, columnIndex);
      }
    }
  }, [
    savePending,
    setActiveCell,
    rowIndex,
    columnIndex,
    onEditNextRow,
    propValCount,
  ]);

  return (
    <Cell
      rowIndex={rowIndex}
      columnIndex={columnIndex}
      align={alignment}
      onEnterEditModeWithCharacter={handleEnterEditModeWithCharacter}
      onEditNextRow={handleEditNextRow}
    >
      {isEditing ? (
        <Editor.Edit
          value={value}
          onChange={onChange}
          property={property.subject}
          resource={resource}
        />
      ) : (
        <Editor.Display
          value={value}
          onChange={onChange}
          property={property.subject}
        />
      )}
    </Cell>
  );
}
