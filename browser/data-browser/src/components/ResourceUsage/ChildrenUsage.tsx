import { Resource, properties, useCollection } from '@tomic/react';

import { UsageCard } from './UsageCard';

import type { JSX } from 'react';

interface ChildrenUsageProps {
  resource: Resource;
}

export function ChildrenUsage({ resource }: ChildrenUsageProps): JSX.Element {
  const { collection } = useCollection({
    property: properties.parent,
    value: resource.getSubject(),
  });

  if (collection.totalMembers === 0) {
    return <></>;
  }

  return (
    <UsageCard
      collection={collection}
      title={
        <span>
          This resource has <strong>{collection.totalMembers}</strong> children
        </span>
      }
    />
  );
}
