import {
  core,
  unknownSubject,
  useArray,
  useResource,
  useStore,
  type Property,
} from '@tomic/react';
import { useEffect, useState } from 'react';

/**
 * Every property of a class — what a block's configuration picks from.
 *
 * The same `requires` + `recommends` walk `useTableColumns` does, without the
 * view layering: a block chooses among the columns a row *has*, not among the
 * ones some view happens to show.
 */
export function useClassProperties(
  classSubject: string | undefined,
): Property[] {
  const store = useStore();
  const classResource = useResource(classSubject ?? unknownSubject);
  const [required] = useArray(classResource, core.properties.requires);
  const [recommended] = useArray(classResource, core.properties.recommends);
  const [properties, setProperties] = useState<Property[]>([]);

  // Serialized deps: `useArray` hands back a fresh array every render, and
  // fetching on identity would re-fetch every property forever.
  const key = JSON.stringify([required, recommended]);

  useEffect(() => {
    const [req, rec] = JSON.parse(key) as [string[], string[]];
    let cancelled = false;

    void Promise.all([...req, ...rec].map(p => store.getProperty(p)))
      .then(resolved => {
        if (!cancelled) {
          setProperties(resolved);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [key, store]);

  return properties;
}
