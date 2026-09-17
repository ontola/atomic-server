import { forwardRef } from 'react';
import { styled } from 'styled-components';

type TableRowProps = React.PropsWithChildren<
  Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>
>;

export const TableRow = forwardRef<HTMLDivElement, TableRowProps>(
  ({ children, ...props }, ref) => {
    return (
      <StyledDiv role='row' {...props} ref={ref}>
        {children}
      </StyledDiv>
    );
  },
);

TableRow.displayName = 'TableRow';

const StyledDiv = styled.div`
  display: grid;
  grid-template-columns: var(--table-template-columns);
  height: var(--table-row-height);

  /* Row-scoped affordances (the gutter's comment bubble) stay out of the way
   * until the pointer or focus is somewhere in the row — anywhere, not just
   * over the gutter itself. \`visibility\` rather than \`display\` so the gutter
   * keeps its width and the row number never shifts. A marked element opts out
   * with \`data-persistent\`, for when it has something to report. */
  & [data-row-affordance] {
    visibility: hidden;
  }

  &:hover [data-row-affordance],
  &:focus-within [data-row-affordance],
  & [data-row-affordance][data-persistent] {
    visibility: visible;
  }

  & > div {
    border-bottom: 1px solid ${p => p.theme.colors.bg2};
    border-right: 1px solid ${p => p.theme.colors.bg2};

    &:last-child {
      border-right: none;
    }
  }

  &:last-child > div {
    border-bottom: none;
  }
`;
