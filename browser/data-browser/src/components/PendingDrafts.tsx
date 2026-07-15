import { styled } from 'styled-components';
import {
  drafts,
  useCollection,
  useCollectionPage,
  useDrive,
  type Resource,
} from '@tomic/react';
import { FaCodeBranch } from 'react-icons/fa6';
import { ResourceInline } from '../views/ResourceInline/ResourceInline';
import { Row } from './Row';

interface PendingDraftsProps {
  resource: Resource;
}

/**
 * Shown above a resource's normal view: the drafts that propose changes to it.
 *
 * This is how a reviewer discovers a draft without any inbox or push — the draft
 * carries `originalSubject`, so a reverse query over the drive finds it. It only
 * surfaces drafts the viewer can already read (same drive); a proposal on someone
 * else's drive is invisible here by design, and needs a delivery primitive.
 */
export function PendingDrafts({
  resource,
}: PendingDraftsProps): React.JSX.Element | null {
  const [drive] = useDrive();

  const { collection } = useCollection({
    property: drafts.properties.originalSubject,
    value: resource.subject,
    drive,
  });

  const draftSubjects = useCollectionPage(collection, 0);

  // Don't show it on a draft itself, or when there is nothing pending.
  if (resource.isDraft || draftSubjects.length === 0) {
    return null;
  }

  return (
    <Wrapper>
      <Row center gap='1ch' wrapItems>
        <FaCodeBranch />
        <strong>
          {draftSubjects.length === 1
            ? '1 draft proposes a change to this:'
            : `${draftSubjects.length} drafts propose changes to this:`}
        </strong>
        {draftSubjects.map(subject => (
          <ResourceInline key={subject} subject={subject} />
        ))}
      </Row>
    </Wrapper>
  );
}

/** A bar spanning the view it sits above, matching the DraftBar. */
const Wrapper = styled.aside`
  background-color: ${p => p.theme.colors.bg1};
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  padding: ${p => p.theme.size(2)} 0;
  margin-bottom: ${p => p.theme.size(2)};
`;
