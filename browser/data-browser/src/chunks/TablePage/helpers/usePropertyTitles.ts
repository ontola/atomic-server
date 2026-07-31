import { useResources, type Property } from '@tomic/react';
import { useMemo } from 'react';

/**
 * Human titles for a set of properties. Resolved in one place because the
 * consumers build plain arrays (menu items, summary labels) — there's no
 * per-item component to hang a `useTitle` off.
 */
export function usePropertyTitles(properties: Property[]): Map<string, string> {
  const subjects = useMemo(() => properties.map(p => p.subject), [properties]);
  const resources = useResources(subjects);

  return useMemo(() => {
    const map = new Map<string, string>();

    for (const subject of subjects) {
      const title = resources.get(subject)?.title;

      if (title) {
        map.set(subject, title);
      }
    }

    return map;
  }, [subjects, resources]);
}
