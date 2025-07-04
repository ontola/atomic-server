import type { Version } from '@tomic/react';

const groupFormatter = new Intl.DateTimeFormat('default', {
  month: 'long',
  year: 'numeric',
});

/** Group versions by month for the history UI. */
export function groupVersionsByMonth(
  versions: Version[],
): Record<string, Version[]> {
  return versions.reduceRight(
    (acc, version) => {
      const createdDate = new Date(version.timestamp);
      const groupKey = groupFormatter.format(createdDate);
      const group = acc[groupKey] ?? [];

      return {
        ...acc,
        [groupKey]: [...group, version],
      };
    },
    {} as Record<string, Version[]>,
  );
}
