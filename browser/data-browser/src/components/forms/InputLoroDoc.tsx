import { styled } from 'styled-components';

export const InputLoroDoc = () => {
  return <Subtle>Editing LoroDoc directly is not supported</Subtle>;
};

const Subtle = styled.div`
  color: ${p => p.theme.colors.textLight};
`;
