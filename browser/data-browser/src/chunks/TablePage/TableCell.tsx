import {
  commits,
  Datatype,
  JSONValue,
  Property,
  useDebouncedSave,
  useResource,
  useValue,
} from '@tomic/react';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
} from 'react';
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
import { useResourceContextMenu } from '@components/ResourceContextMenu/ResourceContextMenuContext';
import { RemoteCellPresence, TablePresenceContext } from './TablePresence';
import { useSettings } from '../../helpers/AppSettings';

interface TableCellProps {
  columnIndex: number;
  rowIndex: number;
  subject: string;
  property: Property;
  /** When set, this cell shows a single language of a LocalizedText property
   * (a split-by-language column). */
  languageTag?: string;
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
  languageTag,
  onFirstContent,
}: TableCellProps): JSX.Element {
  const resource = useResource(subject);
  const { contentLanguage } = useSettings();
  const { setActiveCell } = useTableEditorContext();
  const { addItemsToHistoryStack } = useContext(TablePageContext);
  const { openResourceMenu } = useResourceContextMenu();
  // We give an empty error handler to debouncedSave so it doesn't spam the user with error popups when the value is invalid.
  const [save] = useDebouncedSave(resource, SAVE_DEBOUNCE_TIME, emptyFunc);
  const [value, setValue] = useValue(resource, property.subject, valueOpts);

  const [createdAt, setCreatedAt] = useValue(
    resource,
    commits.properties.createdAt,
    { commit: false, commitDebounce: 0 },
  );

  // Remote sessions whose active cell this is. Match on the RESOLVED
  // subject (`resource.subject`, not the `subject` prop): peers announce
  // real `did:ad:` subjects, and a materialized session row's `_new:`
  // prop subject aliases to one.
  const remoteAgents = useContext(TablePresenceContext)
    .rows.get(resource.subject)
    ?.filter(p => p.column === property.subject)
    .map(p => p.agent);

  const dataType = property.datatype;
  const isEditing = useIsEditing(rowIndex, columnIndex);
  const propertyLabel = property.shortname || property.subject;

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

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // While editing, keep the native menu (copy/paste in the input). A
      // virtual `_new:` row isn't a real resource, so the menu no-ops there.
      if (isEditing) {
        return;
      }

      openResourceMenu(subject, e);
    },
    [isEditing, openResourceMenu, subject],
  );

  // The character that opened edit mode, held until the resource catches up.
  //
  // Typing in Visual mode emits the character AND flips to Edit mode in the
  // same handler, but writing the character is async (`setValue` awaits
  // `resource.set`). The editor therefore mounted on the next render with the
  // value as it was BEFORE the keystroke — empty — and the rest of what you
  // typed replaced it, silently eating the first character. Seeding the editor
  // from this synchronous state closes that window; under load (where the write
  // is slower) it was losing the character most of the time.
  const [pendingValue, setPendingValue] = useState<JSONValue | undefined>();

  const handleEnterEditModeWithCharacter = useCallback(
    (key: string) => {
      // A LocalizedText cell replaces only its own language — spreading the
      // existing map keeps the other languages. `appendStringToType` starts
      // from `undefined` (spreadsheet type-over semantics), which for a map
      // value would wipe every language, not just the edited one.
      if (dataType === Datatype.LOCALIZEDTEXT) {
        const map =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, string>)
            : {};
        const next = { ...map, [languageTag ?? contentLanguage]: key };
        setPendingValue(next);
        onChange(next);

        return;
      }

      const next = appendStringToType(undefined, key, dataType);
      setPendingValue(next);
      onChange(next);
    },
    [onChange, dataType, value, languageTag, contentLanguage],
  );

  // The editor's own edits hand control straight back to the resource —
  // waiting for `value` to equal the seed would never fire, since the next
  // keystroke makes it "ro" while the seed is still "r", freezing the editor
  // on the first character.
  const handleEditorChange = useCallback(
    (v: JSONValue) => {
      setPendingValue(undefined);

      return onChange(v);
    },
    [onChange],
  );

  // Leaving edit mode drops the seed regardless.
  useEffect(() => {
    if (!isEditing && pendingValue !== undefined) {
      setPendingValue(undefined);
    }
  }, [isEditing, pendingValue]);

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
      ariaDescription={`${propertyLabel}, row ${rowIndex + 1}`}
      onEnterEditModeWithCharacter={handleEnterEditModeWithCharacter}
      onEditNextRow={handleEditNextRow}
      onContextMenu={handleContextMenu}
    >
      {isEditing ? (
        <Editor.Edit
          value={pendingValue ?? value}
          onChange={handleEditorChange}
          property={property.subject}
          resource={resource}
          languageTag={languageTag}
        />
      ) : (
        <Editor.Display
          value={value}
          onChange={onChange}
          property={property.subject}
          languageTag={languageTag}
        />
      )}
      {remoteAgents && remoteAgents.length > 0 && (
        <RemoteCellPresence agents={remoteAgents} />
      )}
    </Cell>
  );
}
