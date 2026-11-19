import {
  commits,
  Datatype,
  JSONValue,
  Property,
  useDebouncedSave,
  useResource,
  useValue,
} from '@tomic/react';
import { useCallback, useContext, useMemo, type JSX } from 'react';
import { ValueCell, type CellEditStart } from '@tomic/table';
import { CellAlign } from '@chunks/TableEditor/Cell';

import {
  appendStringToType,
  dataTypeAlignmentMap,
  dataTypeCellMap,
} from './dataTypeMaps';
import { StringCell } from './EditorCells/StringCell';
import { floatSeed, integerSeed } from './EditorCells/numberInput';
import { TablePageContext } from './tablePageContext';
import { useColumnLabel } from './helpers/useColumnLabel';
import { createValueChangedHistoryItem } from './helpers/useTableHistory';
import { useResourceContextMenu } from '@components/ResourceContextMenu/ResourceContextMenuContext';
import { RemoteCellPresence, TablePresenceContext } from './TablePresence';
import { useSettings } from '../../helpers/AppSettings';
import { hasUserContent, isUnsavedDraft } from './draftRow';
import { TableCalendarRowContext } from './Calendar/useTableCalendarRow';
import { RepeatSummaryCell } from './Calendar/RepeatSummaryCell';

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

/**
 * Datatypes whose editor reads typed text and stores a value only when it is
 * committed, with the characters it may start from. Typing on such a selected
 * cell seeds the editor with an accepted character instead of writing it as a
 * value (#1822, #1825). Any other character opens the editor on what is stored
 * and is dropped: a letter is not the start of a number.
 */
const textSeededDatatypes = new Map<string, RegExp>([
  [Datatype.DATE, /^.$/u],
  [Datatype.INTEGER, integerSeed],
  [Datatype.FLOAT, floatSeed],
]);

/**
 * Datatypes whose editor cannot start from a typed character at all, so the
 * character is dropped and the editor opens on the stored value. A timestamp
 * editor is a native date-and-time picker: a lone digit is not a time (#1825).
 */
const unseededDatatypes = new Set<string>([Datatype.TIMESTAMP]);

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
  const { addItemsToHistoryStack } = useContext(TablePageContext);
  const calendarRow = useContext(TableCalendarRowContext);
  const { openResourceMenu } = useResourceContextMenu();
  // We give an empty error handler to debouncedSave so it doesn't spam the user with error popups when the value is invalid.
  const [save] = useDebouncedSave(resource, SAVE_DEBOUNCE_TIME, emptyFunc);
  const [value, setValue] = useValue(resource, property.subject, valueOpts);

  const [createdAt, setCreatedAt] = useValue(
    resource,
    commits.properties.createdAt,
    { commit: false, commitDebounce: 0 },
  );

  // Remote sessions whose active cell this is. Match on the resource's own
  // (normalized) subject: that is what peers announce.
  const remoteAgents = useContext(TablePresenceContext)
    .rows.get(resource.subject)
    ?.filter(p => p.column === property.subject)
    .map(p => p.agent);

  const dataType = property.datatype;
  // Announced to screen readers with every cell, so it should be the label
  // the column heading shows rather than the property's identifier.
  const propertyLabel = useColumnLabel(property);

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

      // A draft row stays purely local (the Loro dirty subscriber skips
      // resources that are still `new`, so it never auto-drains) and is
      // materialized when the user moves off it (`useMaterializeWhenDeselected`).
      // NOT persisting per-keystroke is what keeps rapid row entry stable — no
      // save → re-fetch → remount churn reaches the cell mid-typing. Existing
      // rows still persist as you type. Instead of a save spawning the next
      // empty row (the old mechanism), the virtual row spawns it directly on
      // first content via `onFirstContent`.
      if (isUnsavedDraft(resource)) {
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

  const editStart = useMemo<CellEditStart>(() => {
    const accepts = textSeededDatatypes.get(dataType);
    if (accepts) return { kind: 'text', accepts: key => accepts.test(key) };
    if (unseededDatatypes.has(dataType)) return { kind: 'picker' };

    return {
      kind: 'value',
      fromCharacter: (key, current) => {
        if (dataType === Datatype.LOCALIZEDTEXT) {
          const map =
            current && typeof current === 'object' && !Array.isArray(current)
              ? (current as Record<string, string>)
              : {};

          return { ...map, [languageTag ?? contentLanguage]: key };
        }

        return appendStringToType(undefined, key, dataType);
      },
    };
  }, [dataType, languageTag, contentLanguage]);

  return (
    <ValueCell
      identity={JSON.stringify([
        resource.subject,
        property.subject,
        languageTag ?? contentLanguage,
      ])}
      rowIndex={rowIndex}
      columnIndex={columnIndex}
      align={alignment}
      label={propertyLabel}
      value={value}
      onChange={onChange}
      editStart={editStart}
      canAdvance={() => hasUserContent(resource)}
      onContextMenu={event => openResourceMenu(subject, event)}
      renderEditor={state => (
        <Editor.Edit
          {...state}
          property={property.subject}
          resource={resource}
          languageTag={languageTag}
        />
      )}
      renderDisplay={state => {
        const display = (
          <Editor.Display
            {...state}
            property={property.subject}
            languageTag={languageTag}
          />
        );

        return calendarRow?.recurrenceProp?.subject === property.subject ? (
          <RepeatSummaryCell
            resource={resource}
            calendar={calendarRow}
            fallback={display}
          />
        ) : (
          display
        );
      }}
    >
      {remoteAgents && remoteAgents.length > 0 && (
        <RemoteCellPresence agents={remoteAgents} />
      )}
    </ValueCell>
  );
}
