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
  /**
   * Date read from an intrinsic resource propval (e.g. a message's
   * `createdAt`). When provided it is used as the displayed date — and
   * rendered immediately, without waiting on the commit fetch. This is what
   * lets the timestamp survive a refresh: under the DID / sign-at-drain model
   * a `did:ad:commit:<sig>` resource is no longer refetchable, so a date that
   * depends on the commit load disappears on reload. See
   * `planning/commit-retention-and-state-certificates.md` ("History / audit
   * UI").
   */
  createdAt?: Date;
  /**
   * Creator (an agent subject) read from the resource itself — e.g.
   * `useCreatedBy`, which derives it from the genesis Loro change. Preferred
   * over the fetched commit's `signer` so the creator survives a refresh
   * without refetching the (no-longer-refetchable) commit.
   */
  createdBy?: string;
};

/** Shows the latest editor and edit date */
export function CommitDetail({
  commitSubject,
  short,
  createdAt,
  createdBy,
}: Props): JSX.Element | null {
  // Only fetch the commit when the caller hasn't already supplied the creation
  // metadata from the resource's own oplog (createdAt + createdBy). Under
  // sign-at-drain a `did:ad:commit:<sig>` resource is no longer refetchable, so
  // when both are provided we skip the fetch entirely — it would only fail and
  // (pre-fix) blanked the creator/date on refresh. Other callers (generic
  // "last edited" displays) pass neither and still get the commit-fetch path.
  const needsCommit = createdAt === undefined || createdBy === undefined;
  const resource = useResource<Commits.Commit>(
    needsCommit ? commitSubject : undefined,
  );
  const [signer] = useString(resource, commits.properties.signer);
  const [previousCommit] = useString(
    resource,
    commits.properties.previousCommit,
  );

  // Prefer the resource-derived creator; fall back to the commit's signer.
  const creator = createdBy ?? signer;

  const commitCreatedAt = useDate(resource, commits.properties.createdAt);
  const date = createdAt ?? commitCreatedAt;

  if (!commitSubject && !date) {
    return null;
  }

  // Wait for a date. With an explicit `createdAt` we render right away (no
  // commit needed); otherwise the date comes from the commit, so wait for it.
  if (!date || (createdAt === undefined && resource.loading)) {
    return <Detail>-</Detail>;
  }

  // Only link the date to the commit on the legacy commit-fetch path. When the
  // metadata is resource-derived (createdAt/createdBy supplied), the commit is
  // irrelevant — and under sign-at-drain that link wouldn't resolve — so render
  // the date as plain text instead.
  const linkToCommit = needsCommit && !!commitSubject;

  if (short) {
    return (
      <Detail>
        {linkToCommit ? (
          <AtomicLink subject={commitSubject!}>
            <DateTimeRelative date={date} />
          </AtomicLink>
        ) : (
          <DateTimeRelative date={date} />
        )}
      </Detail>
    );
  }

  const dateElement = <DateTime date={date} />;

  return (
    <Detail>
      {creator && <ResourceInline subject={creator} />}
      {'-'}
      {linkToCommit ? (
        <AtomicLink subject={commitSubject!}>
          {previousCommit ? 'edited ' : ''}
          {dateElement}
        </AtomicLink>
      ) : (
        dateElement
      )}{' '}
    </Detail>
  );
}
