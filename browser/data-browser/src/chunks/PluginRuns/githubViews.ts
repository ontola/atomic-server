import { useCallback, useEffect, useState } from 'react';
import { findSchema, useStore } from '@tomic/react';
import { appsForClass } from '@chunks/AppPage/useDriveApps';
import {
  VIEW_KINDS,
  VIEW_KIND_LABELS,
  type ViewKind,
} from '@chunks/TablePage/tableViewKinds';
import { syncableHierarchySchema } from './syncableHierarchy';

export type GitHubViewKind = 'github-organizations' | 'github-repositories';

const GITHUB_VIEWS = [
  { kind: 'github-organizations', rowClass: 'syncable-owner' },
  { kind: 'github-repositories', rowClass: 'syncable-repository' },
] as const;

/** Resolve applicability against this drive's real schema class subjects. */
export function githubViewsForClass(
  classes: Record<string, string> | undefined,
  rowClass: string | undefined,
): GitHubViewKind[] {
  const descriptors = GITHUB_VIEWS.map(({ kind, rowClass: shortname }) => ({
    subject: kind,
    name: VIEW_KIND_LABELS[kind],
    renders: classes?.[shortname] ? [classes[shortname]] : [],
  }));

  return appsForClass(descriptors, rowClass).map(
    view => view.subject as GitHubViewKind,
  );
}

/** Sync is provisioned by the host; GitHub views are chosen for matching rows. */
export function selectableViewKinds(github: GitHubViewKind[]): ViewKind[] {
  return VIEW_KINDS.filter(
    kind =>
      kind !== 'syncables' &&
      (!kind.startsWith('github-') || github.includes(kind as GitHubViewKind)),
  );
}

/** A read-only lookup, refreshed with the view menu so a new schema is visible. */
export function useGitHubViews(drive: string | undefined, rowClass: string) {
  const store = useStore();
  const [revision, setRevision] = useState(0);
  const [resolved, setResolved] = useState<{
    drive: string;
    rowClass: string;
    kinds: GitHubViewKind[];
  }>();
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!drive || !rowClass) return;
    let cancelled = false;

    void findSchema(store, drive, syncableHierarchySchema())
      .then(schema => {
        if (!cancelled)
          setResolved({
            drive,
            rowClass,
            kinds: githubViewsForClass(schema.classes, rowClass),
          });
      })
      .catch(() => {
        // A failed lookup offers the ordinary table views. Opening the menu
        // retries, without creating an ontology or changing the table.
      });

    return () => {
      cancelled = true;
    };
  }, [store, drive, rowClass, revision]);

  return {
    kinds:
      resolved && resolved.drive === drive && resolved.rowClass === rowClass
        ? resolved.kinds
        : [],
    refresh,
  };
}
