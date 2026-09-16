import { css, styled } from 'styled-components';
import { LAYOUT_CONTAINER } from '../helpers/containers';

const common = css`
  margin: auto;
  padding: var(--space-3);
  container: ${LAYOUT_CONTAINER} / inline-size;
  padding-bottom: 10rem;
`;

/** Centered column */
export const ContainerNarrow = styled.div`
  width: min(100%, var(--container-width));
  ${common}
`;

export const ContainerWide = styled.div`
  width: min(100%, var(--container-width-wide));
  ${common}
`;

/** Full-page wrapper */
export const ContainerFull = styled.div`
  container: ${LAYOUT_CONTAINER} / inline-size;
  padding: var(--space-3);
  padding-bottom: 10rem;
`;
