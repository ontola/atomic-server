import { styled } from 'styled-components';
import { Row } from '@components/Row';
import { FaArrowRight } from 'react-icons/fa6';
import { fadeIn } from '@helpers/commonAnimations';

interface FollowUpPromptProps {
  text: string;
  onClick: () => void;
}

export const FollowUpPrompt = ({ text, onClick }: FollowUpPromptProps) => {
  return (
    <PromptButton onClick={onClick}>
      <Row gap='1ch' center>
        <FaArrowRight />
        {text}
      </Row>
    </PromptButton>
  );
};

const PromptButton = styled.button`
  appearance: none;
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  color: var(--color-accent);
  text-align: start;
  word-break: break-all;
  font-size: 0.9rem;
  animation: ${fadeIn} 0.2s ease-in-out;
  &:hover,
  &:focus-visible {
    background-color: var(--color-bg-subtle);
  }
`;
