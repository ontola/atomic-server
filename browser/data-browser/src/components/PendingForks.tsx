import { styled } from 'styled-components';
import {
  forks,
  useCollection,
  useCollectionPage,
  useDrive,
  type Resource,
} from '@tomic/react';
import { FaCodeBranch } from 'react-icons/fa6';
import { ResourceInline } from '../views/ResourceInline/ResourceInline';
import { Row } from './Row';

interface PendingForksProps {
  resource: Resource;
}

/**
 * Shown above a resource's normal view: the forks that propose changes to it.
 *
 * This is how a reviewer discovers a fork without any inbox or push — the fork
 * carries `originalSubject`, so a reverse query over the drive finds it. It only
 * surfaces forks the viewer can already read (same drive); a proposal on someone
 * else's drive is invisible here by design, and needs a delivery primitive.
 */
export function PendingForks({
  resource,
}: PendingForksProps): React.JSX.Element | null {
  const [drive] = useDrive();

  const { collection } = useCollection({
    property: forks.properties.originalSubject,
    value: resource.subject,
    drive,
  });

  const forkSubjects = useCollectionPage(collection, 0);

  // Don't show it on a fork itself, or when there is nothing pending.
  if (resource.isFork || forkSubjects.length === 0) {
    return null;
  }

  return (
    <Wrapper>
      <Row center gap='1ch' wrapItems>
        <FaCodeBranch />
        <strong>
          {forkSubjects.length === 1
            ? '1 fork proposes a change to this:'
            : `${forkSubjects.length} forks propose changes to this:`}
        </strong>
        {forkSubjects.map(subject => (
          <ResourceInline key={subject} subject={subject} />
        ))}
      </Row>
    </Wrapper>
  );
}

/** A bar spanning the view it sits above, matching the ForkBar. */
const Wrapper = styled.aside`
  background-color: ${p => p.theme.colors.bg1};
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  padding: ${p => p.theme.size(2)} 0;
  margin-bottom: ${p => p.theme.size(2)};
`;
