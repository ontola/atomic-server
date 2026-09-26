import { Core, dataBrowser, Datatype, Resource, urls } from '@tomic/react';
import { CheckboxPropertyForm } from './CheckboxPropertyForm';
import { DatePropertyForm } from './DatePropertyForm';
import { FilePropertyForm } from './FilePropertyForm';
import { NumberPropertyForm } from './NumberPropertyForm';
import { RelationPropertyForm } from './RelationPropertyForm';
import { SelectPropertyForm } from './SelectPropertyForm';
import { TextPropertyForm } from './TextPropertyForm';
import { buildComponentFactory } from '@helpers/buildComponentFactory';
import { JSONPropertyForm } from './JSONPropertyForm';
import { LocalizedTextPropertyForm } from './LocalizedTextPropertyForm';

export type PropertyFormCategory =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'file'
  | 'select'
  | 'relation'
  | 'json'
  | 'localizedText';

const TEXT_TYPES = new Set<string>([
  Datatype.STRING,
  Datatype.MARKDOWN,
  Datatype.SLUG,
  Datatype.URI,
]);
const NUMBER_TYPES = new Set<string>([Datatype.INTEGER, Datatype.FLOAT]);
const DATE_TYPES = new Set<string>([Datatype.DATE, Datatype.TIMESTAMP]);

/**
 * The form category a property's editor is chosen by, or `undefined` when the
 * property has no datatype to choose one from.
 *
 * Callers read the property from the store by subject, so it can still be on
 * its way, or have failed to load, while something renders it. Its datatype is
 * then absent, which is a different thing from a datatype we do not recognise:
 * there is no category to give yet, and throwing for it took a whole table page
 * down through its error boundary. A datatype that IS there and is unknown
 * still throws, because that is a real gap in the list below.
 */
export const getCategoryFromResource = (
  resource: Resource<Core.Property>,
): PropertyFormCategory | undefined => {
  const datatype = resource.props.datatype as Datatype | undefined;

  if (datatype === undefined) {
    return undefined;
  }

  if (TEXT_TYPES.has(datatype)) {
    return 'text';
  }

  if (NUMBER_TYPES.has(datatype)) {
    return 'number';
  }

  if (datatype === Datatype.BOOLEAN) {
    return 'checkbox';
  }

  if (DATE_TYPES.has(datatype)) {
    return 'date';
  }

  if (datatype === Datatype.RESOURCEARRAY) {
    if (
      resource.props.classtype === dataBrowser.classes.tag ||
      resource.hasClasses(urls.classes.constraintProperties.selectProperty)
    ) {
      return 'select';
    }

    return 'relation';
  }

  if (datatype === Datatype.JSON) {
    return 'json';
  }

  if (datatype === Datatype.LOCALIZEDTEXT) {
    return 'localizedText';
  }

  if (datatype === Datatype.ATOMIC_URL) {
    return 'relation';
  }

  throw new Error(`Unknown datatype: ${datatype}`);
};

const NoCategorySelected = () => {
  return <span>No Type selected</span>;
};

export const categoryFormFactory = buildComponentFactory(
  new Map([
    ['text', TextPropertyForm],
    ['number', NumberPropertyForm],
    ['checkbox', CheckboxPropertyForm],
    ['select', SelectPropertyForm],
    ['date', DatePropertyForm],
    ['file', FilePropertyForm],
    ['json', JSONPropertyForm],
    ['localizedText', LocalizedTextPropertyForm],
    ['relation', RelationPropertyForm],
  ]),
  NoCategorySelected,
);
