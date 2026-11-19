import { Datatype, server } from '@tomic/react';

import { InputProps } from './ResourceField.js';
import InputString from './InputString.js';
import { InputResource } from './InputResource.js';
import InputResourceArray from './InputResourceArray.js';
import InputMarkdown from './InputMarkdown.js';
import InputNumber from './InputNumber.js';
import InputBoolean from './InputBoolean.js';
import InputSlug from './InputSlug.js';
import { InputTimestamp } from './InputTimestamp.js';
import { InputDate } from './InputDate.js';
import { useConstrainedProperty } from '../../helpers/withConstraint.js';
import { FilePicker } from './FilePicker/FilePicker.js';

import type { JSX } from 'react';
import { InputJSON } from './InputJSON.js';
import InputURI from './InputURI.js';
import { InputLoroDoc } from './InputLoroDoc.js';
import InputLocalizedText from './InputLocalizedText.js';

/** Renders a fitting HTML input depending on the Datatype */
export default function InputSwitcher(inputProps: InputProps): JSX.Element {
  // The resource's classes may narrow the Property: options from `enum`, the
  // linked class from `class`. See `planning/class-constraints-and-forms.md`.
  const property = useConstrainedProperty(
    inputProps.resource,
    inputProps.property,
  );
  const props = { ...inputProps, property };

  switch (props.property.datatype) {
    case Datatype.STRING: {
      return <InputString {...props} />;
    }

    case Datatype.MARKDOWN: {
      return <InputMarkdown {...props} />;
    }

    case Datatype.SLUG: {
      return <InputSlug {...props} />;
    }

    case Datatype.INTEGER: {
      return <InputNumber {...props} />;
    }

    case Datatype.FLOAT: {
      return <InputNumber {...props} />;
    }

    case Datatype.ATOMIC_URL: {
      if (props.property.classType === server.classes.file) {
        return <FilePicker {...props} />;
      }

      return <InputResource {...props} />;
    }

    case Datatype.RESOURCEARRAY: {
      return <InputResourceArray {...props} />;
    }

    case Datatype.BOOLEAN: {
      return <InputBoolean {...props} />;
    }

    case Datatype.TIMESTAMP: {
      return <InputTimestamp {...props} />;
    }

    case Datatype.DATE: {
      return <InputDate {...props} />;
    }

    case Datatype.JSON: {
      return <InputJSON {...props} />;
    }

    case Datatype.URI: {
      return <InputURI {...props} />;
    }

    case Datatype.LORODOC: {
      return <InputLoroDoc />;
    }

    case Datatype.LOCALIZEDTEXT: {
      return <InputLocalizedText {...props} />;
    }

    default: {
      return <InputString {...props} />;
    }
  }
}
