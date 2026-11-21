import type { JSX } from 'react';
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

import { JSONRenderer } from './datatypes/JSON.js';
import { AtomicLink } from './AtomicLink.js';
import { LoroDocValue } from './LoroDocValue.js';

type Props = {
  value: AtomicValue;
  datatype: Datatype;
};

/** Renders a value in a fitting way, depending on its DataType */
function ValueComp({ value, datatype }: Props): JSX.Element {
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

export default ValueComp;
