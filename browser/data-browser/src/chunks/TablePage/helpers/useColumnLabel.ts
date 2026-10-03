import {
  core,
  unknownSubject,
  useResource,
  useString,
  type Property,
} from '@tomic/react';
import { columnLabel } from './columnLabel';

/**
 * {@link columnLabel} for a single property, read live from the property's
 * own resource. For a list of properties use `usePropertyTitles` instead.
 * Returns an empty string when there is no property (a computed column).
 */
export function useColumnLabel(
  property: Pick<Property, 'subject' | 'shortname'> | undefined,
): string {
  const resource = useResource(property?.subject ?? unknownSubject);
  const [name] = useString(resource, core.properties.name);

  if (!property) return '';

  return columnLabel(name, property.shortname || property.subject);
}
