import { useEffect, useMemo, useState } from 'react';
import {
  core,
  server,
  unknownSubject,
  useResource,
  useResources,
  useStore,
  useValue,
} from '@tomic/react';
import {
  hiddenSyncableSetups,
  syncableSetupSubjects,
  syncableSetupVisibilityTerms,
  type SetupVisibilityTerms,
} from './syncableSetupVisibility';

/** Setup is reached through Apps; the drive displays only installed principals. */
export function useSyncableSetupSubjects(drive: string): Set<string> {
  const store = useStore();
  const resource = useResource(drive);
  const serverOrigin = store.getServerUrl?.() ?? '';
  const [ontologySubject] = useValue(
    resource,
    server.properties.defaultOntology,
  );
  const ontology = useResource(
    typeof ontologySubject === 'string' ? ontologySubject : unknownSubject,
  );
  const [properties] = useValue(ontology, core.properties.properties);
  const [classes] = useValue(ontology, core.properties.classes);
  const [resolved, setResolved] = useState<{
    drive: string;
    terms: SetupVisibilityTerms;
  }>();
  useEffect(() => {
    let active = true;
    void syncableSetupVisibilityTerms(store, drive)
      .then(terms => {
        if (active) setResolved({ drive, terms });
      })
      .catch(() => {
        if (active) setResolved({ drive, terms: { properties: {} } });
      });

    return () => {
      active = false;
    };
  }, [store, drive, ontologySubject, properties, classes]);
  const terms =
    resolved && resolved.drive === drive ? resolved.terms : undefined;
  const [index] = useValue(
    resource,
    terms?.properties['syncable-platform-index'] ?? unknownSubject,
  );
  const subjects = useMemo(
    () => syncableSetupSubjects(index, serverOrigin),
    [index, serverOrigin],
  );
  const rows = useResources(subjects);

  return useMemo(
    () =>
      terms ? hiddenSyncableSetups(index, rows, terms) : new Set<string>(),
    [index, rows, terms],
  );
}
