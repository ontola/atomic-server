import { PropsWithChildren, memo, type JSX } from 'react';
import { VisuallyHidden } from './VisuallyHidden';
import { styled } from 'styled-components';
import {
  RESOURCE_PAGE_TRANSITION_TAG,
  transitionName,
} from '../helpers/transitionName';
import { ViewTransitionProps } from '../helpers/ViewTransitionProps';
import Parent from './Parent';
import { useResource } from '@tomic/react';
import { CalculatedPageHeight } from '../globalCssVars';

/** Main landmark. Every page should have one of these.
 * If the pages shows a resource a subject can be passed that enables view transitions to work. */
export function Main({
  subject,
  children,
}: PropsWithChildren<ViewTransitionProps>): JSX.Element {
  const resource = useResource(subject);

  return (
    <>
      {subject && <Parent resource={resource} />}
      <StyledMain subject={subject} about={subject}>
        <VisuallyHidden>
          <a href='#skip-to-content' id='skip-to-content' tabIndex={-1}>
            Start of main content
          </a>
        </VisuallyHidden>
        {children}
      </StyledMain>
    </>
  );
}

const StyledMain = memo(styled.main<ViewTransitionProps>`
  ${p => transitionName(RESOURCE_PAGE_TRANSITION_TAG, p.subject)};
  height: calc(
    ${CalculatedPageHeight.var()} - ${p => p.theme.heights.breadCrumbBar}
  );
  overflow-y: auto;
  scroll-padding: calc(
    ${p => p.theme.heights.breadCrumbBar} + ${p => p.theme.size(2)}
  );

  width: 100cqw;

  @media (prefers-reduced-motion: no-preference) {
    scroll-behavior: smooth;
  }

  @media print {
    display: block;
    position: static;
    height: auto;
    overflow-y: visible;
    overflow: visible;
    scroll-padding: 0;
    page-break-after: auto;
    page-break-inside: auto;
  }
`);
