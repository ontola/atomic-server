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
  /** Called on every edit; the row uses it to spawn a trailing placeholder the
   * first time a virtual new row gains content (no-op for existing rows). */
  onFirstContent?: () => void;
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
  onFirstContent,
}: TableCellProps): JSX.Element {
  const resource = useResource(subject);
  const { setActiveCell } = useTableEditorContext();
  const { addItemsToHistoryStack } = useContext(TablePageContext);
  // We give an empty error handler to debouncedSave so it doesn't spam the user with error popups when the value is invalid.
  const [save] = useDebouncedSave(resource, SAVE_DEBOUNCE_TIME, emptyFunc);
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

      // A `_new:` row is virtual: it stays purely local (the Loro dirty
      // subscriber skips `_new:` subjects, so it never auto-drains) and is
      // materialized when the user moves off it (`useMaterializeWhenDeselected`).
      // NOT persisting per-keystroke is what keeps rapid row entry stable — no
      // save → re-fetch → remount churn reaches the cell mid-typing. Existing
      // rows still persist as you type. Instead of a save spawning the next
      // empty row (the old mechanism), the virtual row spawns it directly on
      // first content via `onFirstContent`.
      if (resource.subject.startsWith('_new:')) {
        onFirstContent?.();
      } else {
        save();
      }
    },
    [
      setValue,
      setCreatedAt,
      createdAt,
      resource,
      property.subject,
      save,
      onFirstContent,
      addItemsToHistoryStack,
    ],
  );

  const handleEnterEditModeWithCharacter = useCallback(
    (key: string) => {
      onChange(appendStringToType(undefined, key, dataType));
    },
    [onChange, dataType],
  );

  const handleEditNextRow = useCallback(() => {
    // Advance to the next row. The trailing empty row to move into already
    // exists — a virtual row spawns its successor via `onFirstContent` the
    // moment it gains content — so this is pure navigation, no spawning here.
    //
    // Only advance if this row has real content (a fresh row has just `isA` +
    // `parent`) — avoids hopping off an empty row on a stray Enter. Read the
    // count FRESH from the resource, not a render-time snapshot: the keystroke
    // just typed updates the resource synchronously, but the cell's rerender
    // lags under load, so a stale closure would skip the advance — piling the
    // next value onto the same cell.
    if (resource.getEntries().length > 2) {
      setActiveCell(rowIndex + 1, columnIndex);
    }
  }, [setActiveCell, rowIndex, columnIndex, resource]);

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
