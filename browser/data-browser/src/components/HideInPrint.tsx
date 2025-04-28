import { styled } from 'styled-components';

export const HideInPrint = styled.div`
  display: contents;
  @media print {
    display: none;
  }
`;
