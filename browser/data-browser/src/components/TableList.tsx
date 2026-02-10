import { styled } from 'styled-components';

export const TableList = styled.table`
  width: 100%;
  border-collapse: collapse;

  td {
    padding: ${p => p.theme.size(2)};

    &:first-child {
      padding-inline-start: 0;
    }
  }

  tr {
    &:not(:last-child) {
      border-bottom: 1px solid ${p => p.theme.colors.bg2};
    }
  }
`;
