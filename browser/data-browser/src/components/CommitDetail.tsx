import {
  commits,
  useDate,
  useResource,
  useString,
  type Commits,
} from '@tomic/react';
import { ResourceInline } from '../views/ResourceInline';
import { Detail } from './Detail';
import { DateTime, DateTimeRelative } from './datatypes/DateTime';
import { AtomicLink } from './AtomicLink';

import type { JSX } from 'react';

type Props = {
  commitSubject?: string;
  short?: boolean;
};

/** Shows the latest editor and edit date */
export function CommitDetail({
  commitSubject,
  short,
}: Props): JSX.Element | null {
  const resource = useResource<Commits.Commit>(commitSubject);
  const [signer] = useString(resource, commits.properties.signer);
  const [previousCommit] = useString(
    resource,
    commits.properties.previousCommit,
  );

  const createdAt = useDate(resource, commits.properties.createdAt);

  if (!commitSubject) {
    return null;
  }

  if (!commitSubject || resource.loading || !createdAt) {
    return <Detail>-</Detail>;
  }

  if (short) {
    return (
      <Detail>
        <AtomicLink subject={commitSubject}>
          <DateTimeRelative date={createdAt} />
        </AtomicLink>
      </Detail>
    );
  }

  return (
    <Detail>
      {signer && <ResourceInline subject={signer} />}
      {'-'}
      <AtomicLink subject={commitSubject}>
        {previousCommit ? 'edited ' : ''}
        {createdAt && <DateTime date={createdAt} />}
      </AtomicLink>{' '}
    </Detail>
  );
}
