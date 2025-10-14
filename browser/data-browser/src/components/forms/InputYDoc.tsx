import { styled } from 'styled-components';

export const InputYDoc = () => {
  return <Subtle>Editing YDoc directly is not supported</Subtle>;
};

const Subtle = styled.div`
  color: ${p => p.theme.colors.textLight};
`;
