import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaChevronDown, FaChevronUp } from 'react-icons/fa6';
import {
  Datatype,
  isSafeHref,
  valToDate,
  valToString,
  valToArray,
  valToResource,
  type AtomicValue,
  type JSONValue,
  type LocalizedText,
} from '@tomic/react';
import { LocalizedTextValue } from './LocalizedTextValue.js';
import { ResourceInline } from '../views/ResourceInline/index.js';
import { CalendarDate, DateTime } from './datatypes/DateTime.js';
import Markdown from './datatypes/Markdown.js';
import Nestedresource from './datatypes/NestedResource.js';
import ResourceArray from './datatypes/ResourceArray.js';
import { ErrMessage } from '@tomic/ui/components/forms/InputStyles';
import { IconButton } from '@tomic/ui/components/IconButton/IconButton';
import { markdownToPlainText } from '../helpers/markdown.js';

import { JSONRenderer } from './datatypes/JSON.js';
import { AtomicLink } from './AtomicLink.js';
import { LoroDocValue } from './LoroDocValue.js';

type Props = {
  value: AtomicValue;
  datatype: Datatype;
  /**
   * Fit the value on a single line, ending in an ellipsis, with a button that
   * shows the full value when it does not fit or loses formatting. For
   * property tables, where one long value should not push the rest away.
   */
  oneLine?: boolean;
};

/** Renders a value in a fitting way, depending on its DataType */
function ValueComp({ value, datatype, oneLine }: Props): JSX.Element {
  if (oneLine) {
    return <OneLineValue value={value} datatype={datatype} />;
  }

  try {
    return renderValue(value, datatype);
  } catch (e) {
    return (
      <ErrMessage>
        {e.message} original value: {value?.toString()}
      </ErrMessage>
    );
  }
}

function renderValue(value: AtomicValue, datatype: Datatype): JSX.Element {
  switch (datatype) {
    case Datatype.ATOMIC_URL: {
      const resource = valToResource(value);

      if (typeof resource === 'string') {
        return <ResourceInline subject={resource} />;
      }

      return <Nestedresource resource={resource} />;
    }

    case Datatype.DATE:
      return <CalendarDate value={valToString(value)} />;
    case Datatype.TIMESTAMP:
      return <DateTime date={valToDate(value)} />;
    case Datatype.MARKDOWN:
      return <Markdown text={valToString(value)} />;
    case Datatype.RESOURCEARRAY:
      return <ResourceArray subjects={valToArray(value)} />;
    case Datatype.JSON:
      return <JSONRenderer value={value as JSONValue} />;
    case Datatype.LORODOC:
      return <LoroDocValue value={value as Uint8Array} />;

    case Datatype.LOCALIZEDTEXT:
      return <LocalizedTextValue value={value as LocalizedText} />;

    case Datatype.URI: {
      const uri = value as string;

      // Shown but not linked when the scheme would run rather than navigate.
      if (!isSafeHref(uri)) {
        return <div>{uri}</div>;
      }

      return <AtomicLink href={uri}>{uri}</AtomicLink>;
    }

    default:
      return <div>{valToString(value)}</div>;
  }
}

/**
 * The one-line form of a value, for the datatypes whose full form is a block
 * (markdown, JSON). The others already render inline and are clipped as is.
 */
function renderCollapsed(value: AtomicValue, datatype: Datatype): JSX.Element {
  switch (datatype) {
    case Datatype.MARKDOWN:
      return <>{markdownToPlainText(valToString(value))}</>;
    case Datatype.JSON:
      return <code>{JSON.stringify(value)}</code>;
    default:
      return <ValueComp value={value} datatype={datatype} />;
  }
}

/** Whether the one-line form drops something even when it fits. */
function isLossy(value: AtomicValue, datatype: Datatype): boolean {
  switch (datatype) {
    case Datatype.MARKDOWN: {
      const text = valToString(value);

      return text.includes('\n') || markdownToPlainText(text) !== text;
    }

    case Datatype.JSON:
      return typeof value === 'object' && value !== null;
    case Datatype.ATOMIC_URL:
      // A nested resource is a list of properties: never one line.
      return typeof value === 'object' && value !== null;
    default:
      return false;
  }
}

function OneLineValue({ value, datatype }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) return;

    const measure = () =>
      setOverflows(
        el.scrollWidth > el.clientWidth + 1 ||
          el.scrollHeight > el.clientHeight + 1,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => observer.disconnect();
  }, [expanded, value]);

  const canExpand = expanded || overflows || isLossy(value, datatype);

  return (
    <OneLineRow>
      {expanded ? (
        <Full>
          <ValueComp value={value} datatype={datatype} />
        </Full>
      ) : (
        <OneLine ref={ref}>{renderCollapsed(value, datatype)}</OneLine>
      )}
      {canExpand && (
        <ExpandButton
          title={expanded ? 'Show less' : 'Show all'}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <FaChevronUp /> : <FaChevronDown />}
        </ExpandButton>
      )}
    </OneLineRow>
  );
}

/** Clips inline content to one line with an ellipsis. */
export const OneLine = styled.span`
  display: block;
  min-width: 0;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Inline content that is a block (a glyph, a thumbnail) stays on the line. */
  max-height: 1lh;

  & * {
    white-space: nowrap;
  }
`;

const OneLineRow = styled.span`
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
  min-width: 0;
`;

const Full = styled.span`
  display: block;
  min-width: 0;
  flex: 1;
  word-break: break-word;
`;

const ExpandButton = styled(IconButton)`
  && {
    flex-shrink: 0;
    /* As tall as the line, so the row does not grow. */
    height: 1.5em;
    padding-block: 0;
    opacity: 0.6;
  }

  &&:hover,
  &&:focus-visible {
    opacity: 1;
  }
`;

export default ValueComp;
