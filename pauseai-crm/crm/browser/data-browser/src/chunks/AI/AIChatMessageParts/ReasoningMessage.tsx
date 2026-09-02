import Markdown from '@components/datatypes/Markdown';
import styled from 'styled-components';
import { FaBrain } from 'react-icons/fa6';
import { Details } from '@components/Details';
import { Shimmer } from '@components/Shimmer';
import { PartSummary } from './PartSummary';

const ReasoningMessageWrapper = styled.div`
  padding: ${p => p.theme.size()};
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
  border-radius: ${p => p.theme.radius};
  width: 90%;
`;

const ReasoningSummary = ({ streaming }: { streaming?: boolean }) => (
  <PartSummary $interactive={!streaming}>
    <FaBrain />
    <span>{streaming ? 'Thinking...' : 'Thinking'}</span>
  </PartSummary>
);

export const ReasoningMessage = ({
  text,
  state,
}: {
  text: string;
  state?: 'streaming' | 'done';
}) => {
  if (state === 'streaming') {
    return (
      <>
        <Shimmer>
          <ReasoningSummary streaming />
        </Shimmer>
        <ReasoningMessageWrapper>
          <Markdown text={text} maxLength={Infinity} />
        </ReasoningMessageWrapper>
      </>
    );
  }

  if (text === '[REDACTED]') {
    return (
      <Details noIndent titleButton={<ReasoningSummary />}>
        <ReasoningMessageWrapper>{text}</ReasoningMessageWrapper>
      </Details>
    );
  }

  return (
    <Details noIndent titleButton={<ReasoningSummary />}>
      <ReasoningMessageWrapper>
        <Markdown text={text} maxLength={Infinity} />
      </ReasoningMessageWrapper>
    </Details>
  );
};
