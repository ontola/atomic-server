import { core, server, unknownSubject, useCollection } from '@tomic/react';
import { useEffect, useState } from 'react';

/**
 * Installations on a drive, live: a collection query subscribes to the
 * server, so an install (or an uninstall) shows up without a reload.
 */
export function useInstallations(drive: string): string[] {
  const [subjects, setSubjects] = useState<string[]>([]);

  const { collection, ready } = useCollection(
    {
      property: core.properties.isA,
      value: server.classes.installation,
      drive: drive || unknownSubject,
    },
    { pageSize: 100 },
  );

  useEffect(() => {
    if (!ready || !drive) {
      setSubjects([]);

      return;
    }

    let cancelled = false;

    const extract = async () => {
      const members: string[] = [];

      for (let i = 0; i < collection.totalMembers; i++) {
        const member = await collection.getMemberWithIndex(i);

        if (member) members.push(member);
      }

      if (!cancelled) setSubjects(members);
    };

    extract().catch(() => {
      // Shown as empty; the drive may be on a server without the
      // Installation class.
    });

    return () => {
      cancelled = true;
    };
  }, [collection, ready, drive]);

  return subjects;
}
