import { useCollection, type Resource } from '@tomic/react';
import { UsageCard } from './UsageCard';

interface ReferenceUsageProps {
  resource: Resource;
  initialOpenState?: boolean;
  /**
   * Scope the lookup to references via a specific property. Passing this lets
   * the query be answered from the local OPFS index (which needs both a
   * property and a value), so it works on local-first drives — same path
   * `useChildren` takes. Without it the query is value-only and falls back to
   * the server `/query`.
   */
  property?: string;
}

export function ReferenceUsage({
  resource,
  initialOpenState,
  property,
}: ReferenceUsageProps) {
  const { collection } = useCollection(
    { property, value: resource.subject },
    { pageSize: 10 },
  );

  return (
    <UsageCard
      initialOpenState={initialOpenState}
      collection={collection}
      title={
        <span>
          <strong>{collection.totalMembers}</strong> resources reference{' '}
          {resource.title}
        </span>
      }
    />
  );
}
