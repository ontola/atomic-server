import { useEffect, useState } from 'react';
import { core, useStore } from '@tomic/react';

/** Inspect the resource's declared classes, not every term in the drive ontology. */
export function useWebsiteClass(classKey: string) {
  const store = useStore();
  const [resolved, setResolved] = useState<{ key: string; subject?: string }>();
  useEffect(() => {
    let active = true;
    const classes = classKey.split('|').filter(Boolean);

    const resolve = async () => {
      for (const id of classes) {
        const resource = await store.getResource(id);
        if (!active) return;

        if (resource.get(core.properties.shortname) === 'website-project') {
          setResolved({ key: classKey, subject: id });

          return;
        }
      }

      if (active) setResolved({ key: classKey });
    };

    const unsubscribes = classes.map(id =>
      store.subscribe(id, () => {
        void resolve().catch(() => undefined);
      }),
    );
    void resolve().catch(() => undefined);

    return () => {
      active = false;
      unsubscribes.forEach(unsubscribe => unsubscribe());
    };
  }, [store, classKey]);

  return resolved?.key === classKey ? resolved.subject : undefined;
}
