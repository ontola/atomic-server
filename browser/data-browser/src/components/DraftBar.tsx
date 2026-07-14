import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { drafts, type Resource } from '@tomic/react';
import { FaCodeBranch, FaCodeMerge } from 'react-icons/fa6';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { ResourceInline } from '../views/ResourceInline/ResourceInline';
import { Button } from './Button';
import { Row } from './Row';

interface DraftBarProps {
  resource: Resource;
}

/**
 * Shown above a Draft's normal view. A draft renders through the same view as
 * the resource it forked — it carries that resource's classes — so without this
 * bar there is nothing on screen to say you are not looking at the original.
 */
export function DraftBar({
  resource,
}: DraftBarProps): React.JSX.Element | null {
  const navigate = useNavigateWithTransition();
  const original = resource.get(drafts.properties.originalSubject);

  if (!resource.isDraft || !original) {
    return null;
  }

  const merge = async () => {
    try {
      const merged = await resource.mergeIntoOriginal();
      toast.success('Draft merged');
      navigate(constructOpenURL(merged.subject));
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const discard = async () => {
    try {
      await resource.destroy();
      toast.success('Draft discarded');
      navigate(constructOpenURL(original));
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <Wrapper>
      <Row justify='space-between' center gap='1ch'>
        {/* Each translatable string stays whole and separate from the resource
            link: wuchale turns a sentence with a component spliced into it into
            an array of children, which React then wants keys for. */}
        <Row center gap='1ch'>
          <FaCodeBranch />
          <span>Draft of</span>
          <ResourceInline subject={original} />
          <Subtle>The original is unchanged until you merge.</Subtle>
        </Row>
        <Row center gap='1ch'>
          <Button subtle onClick={discard}>
            Discard
          </Button>
          <Button onClick={merge}>
            <FaCodeMerge /> Merge
          </Button>
        </Row>
      </Row>
    </Wrapper>
  );
}

const Subtle = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

/** A bar, not a card: it spans the view it sits above rather than floating in it. */
const Wrapper = styled.aside`
  background-color: ${p => p.theme.colors.bg1};
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  padding: ${p => p.theme.size(2)} 0;
  margin-bottom: ${p => p.theme.size(2)};
`;
