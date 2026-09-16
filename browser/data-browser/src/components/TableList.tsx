import { styled } from 'styled-components';

export const TableList = styled.table`
  width: 100%;
  border-collapse: collapse;

  td {
    padding: var(--space-2);

    &:first-child {
      padding-inline-start: 0;
    }
  }

  tr {
    &:not(:last-child) {
      border-bottom: 1px solid var(--color-border);
    }
  }
`;
