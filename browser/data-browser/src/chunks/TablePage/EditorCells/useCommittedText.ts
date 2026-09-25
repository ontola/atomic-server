import { JSONValue } from '@tomic/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TableEvent,
  useTableEditorContext,
} from '@chunks/TableEditor/TableEditorContext';
import { KeyboardInteraction } from '@chunks/TableEditor/helpers/keyboardHandlers';

/** What `parse` returns for text that is not (yet) a value of the type. */
export const UNPARSED = Symbol('unparsed');

interface CommittedTextOptions {
  value: JSONValue;
  onChange: (value: JSONValue) => void;
  /** The character typed on the selected cell, which the text starts from. */
  seed?: string;
  format: (value: JSONValue) => string;
  /** The value the text stands for, or `UNPARSED` when it stands for none. */
  parse: (text: string) => JSONValue | typeof UNPARSED;
}

/**
 * State for a cell editor whose text is not a value until it is finished:
 * `-` or `2.` on the way to a number, `2/10` on the way to a date. Nothing is
 * stored while typing. The text is stored once, on Enter or Tab or when the
 * cell closes another way, and only if it parses. Escape stores nothing.
 */
export function useCommittedText({
  value,
  onChange,
  seed,
  format,
  parse,
}: CommittedTextOptions) {
  const [initial] = useState(() => format(value));
  const [text, setText] = useState(seed ?? initial);
  // Empty text is not flagged: it is where every value starts.
  const invalid = text.trim() !== '' && parse(text) === UNPARSED;

  // The unmount cleanup must see the last keystroke, not the first render.
  const latest = useRef({ text, value, onChange, parse });

  useEffect(() => {
    latest.current = { text, value, onChange, parse };
  });

  const committed = useRef(initial);
  const cancelled = useRef(false);

  const commit = useCallback(() => {
    const {
      text: current,
      value: stored,
      onChange: save,
      parse: read,
    } = latest.current;

    if (cancelled.current || current === committed.current) {
      return;
    }

    const next = read(current);

    if (next !== UNPARSED && next !== stored) {
      committed.current = current;
      save(next);
    }
  }, []);

  useEffect(() => () => commit(), [commit]);

  // The table takes Escape before the input sees it, and closing the cell
  // would commit. It tells the editor first, so Escape can drop the text.
  const { registerEventListener } = useTableEditorContext();

  useEffect(
    () =>
      registerEventListener(TableEvent.InteractionsFired, interactions => {
        if (interactions.includes(KeyboardInteraction.ExitEditMode)) {
          cancelled.current = true;
        }
      }),
    [registerEventListener],
  );

  const onTextChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    latest.current = { ...latest.current, text: e.target.value };
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Before the table moves on, so a new row sees its value.
      if (e.key === 'Enter' || e.key === 'Tab') {
        commit();
      }
    },
    [commit],
  );

  return {
    value: text,
    onChange: onTextChange,
    onKeyDown,
    'aria-invalid': invalid || undefined,
  };
}
