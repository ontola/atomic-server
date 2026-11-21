import { resourceTheme } from '../../../theme.js';
import { AtomicLink } from '../../../components/AtomicLink.js';
import { getIconForClass } from '../../../helpers/iconMap.js';
import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { dataBrowser, useResource } from '@tomic/react';
import { useResourceUIHost } from '../../../ResourceUIHost.js';
import { styled } from 'styled-components';
import { RTENodeViewWrapper } from './RTENodeViewWrapper.js';
import { ErrorBoundary } from '../../../components/ErrorBoundary.js';

export const ResourceComponent = (
  props: ReactNodeViewProps<HTMLDivElement>,
) => {
  const resource = useResource(props.node.attrs.subject);

  const { ResourceCard: Component } = useResourceUIHost();
  const wide = resource.hasClasses(dataBrowser.classes.table);

  return (
    <RTENodeViewWrapper wide={wide} key={props.node.attrs.subject}>
      <ErrorBoundary>
        <Component
          subject={props.node.attrs.subject}
          highlight={props.selected}
        />
      </ErrorBoundary>
    </RTENodeViewWrapper>
  );
};

export const ResourceInlineComponent = (
  props: ReactNodeViewProps<HTMLAnchorElement>,
) => {
  const resource = useResource(props.node.attrs.subject);
  const Icon = getIconForClass(resource.getClasses()[0]);

  return (
    <NodeViewWrapper as='span'>
      <StyledAtomicLink clean subject={resource.subject}>
        <Icon />
        {resource.title}
      </StyledAtomicLink>
    </NodeViewWrapper>
  );
};

const StyledAtomicLink = styled(AtomicLink)`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  color: ${props => resourceTheme(props.theme).colors.mainSelectedFg};
  background-color: ${props =>
    resourceTheme(props.theme).colors.mainSelectedBg};
  padding: 0rem 0.4rem;
  border-radius: ${props => resourceTheme(props.theme).radius};
  border: 1px solid ${props => resourceTheme(props.theme).colors.mainSelectedFg};
  user-select: none;
`;
