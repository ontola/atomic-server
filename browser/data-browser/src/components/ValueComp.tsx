import type { JSX } from 'react';
import {
  Datatype,
  valToDate,
  valToString,
  valToArray,
  valToResource,
  type AtomicValue,
  type JSONValue,
} from '@tomic/react';
import { ResourceInline } from '../views/ResourceInline';
import { DateTime } from './datatypes/DateTime';
import Markdown from './datatypes/Markdown';
import Nestedresource from './datatypes/NestedResource';
import ResourceArray from './datatypes/ResourceArray';
import { ErrMessage } from './forms/InputStyles';

import { JSONRenderer } from './datatypes/JSON';
import { AtomicLink } from './AtomicLink';
import { LoroDocValue } from './LoroDocValue';

type Props = {
  value: AtomicValue;
  datatype: Datatype;
};

/** Renders a value in a fitting way, depending on its DataType */
function ValueComp({ value, datatype }: Props): JSX.Element {
  try {
    switch (datatype) {
      case Datatype.ATOMIC_URL: {
        const resource = valToResource(value);

        if (typeof resource === 'string') {
          return <ResourceInline subject={resource} />;
        }

        return <Nestedresource resource={resource} />;
      }

      case (Datatype.DATE, Datatype.TIMESTAMP):
        return <DateTime date={valToDate(value)} />;
      case Datatype.MARKDOWN:
        return <Markdown text={valToString(value)} />;
      case Datatype.RESOURCEARRAY:
        return <ResourceArray subjects={valToArray(value)} />;
      case Datatype.JSON:
        return <JSONRenderer value={value as JSONValue} />;
      case Datatype.LORODOC:
        return <LoroDocValue value={value as Uint8Array} />;
      case Datatype.URI:
        return (
          <AtomicLink href={value as string}>{value as string}</AtomicLink>
        );
      default:
        return <div>{valToString(value)}</div>;
    }
  } catch (e) {
    return (
      <ErrMessage>
        {e.message} original value: {value?.toString()}
      </ErrMessage>
    );
  }
}

export default ValueComp;
