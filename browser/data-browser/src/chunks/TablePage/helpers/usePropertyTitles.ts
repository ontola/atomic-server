import { core, useResources, type Property } from '@tomic/react';
import { useMemo } from 'react';
import { columnLabel } from './columnLabel';

/**
 * Human titles for a set of properties. Resolved in one place because the
 * consumers build plain arrays (menu items, summary labels) — there's no
 * per-item component to hang a `useTitle` off.
 *
 * Every property gets an entry: a property with no name of its own is labelled
 * by its shortname, and {@link columnLabel} makes that read like a label rather
 * than like the identifier it is.
 */
export function usePropertyTitles(properties: Property[]): Map<string, string> {
  const entries = useMemo(
    () => properties.map(p => [p.subject, p.shortname] as const),
    [properties],
  );
  const subjects = useMemo(
    () => entries.map(([subject]) => subject),
    [entries],
  );
  const resources = useResources(subjects);

  return useMemo(
    () =>
      new Map(
        entries.map(([subject, shortname]) => [
          subject,
          columnLabel(
            resources.get(subject)?.get(core.properties.name) as
              | string
              | undefined,
            shortname,
          ),
        ]),
      ),
    [entries, resources],
  );
}
