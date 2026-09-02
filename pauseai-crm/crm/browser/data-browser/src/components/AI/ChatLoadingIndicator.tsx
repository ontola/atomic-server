import { styled } from 'styled-components';

export const ChatLoadingIndicator = () => {
  return (
    <Wrapper>
      <LoadingText>Loading AI</LoadingText>
    </Wrapper>
  );
};

const Wrapper = styled.div`
  display: grid;
  place-items: center;
  height: 100%;
  width: 100%;
`;

const LoadingText = styled.div`
  font-size: 1.5rem;
`;
