import { AtomicLink } from '@components/AtomicLink';
import { getIconForClass } from '@helpers/iconMap';
import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { dataBrowser, useResource } from '@tomic/react';
import ResourceCard from '@views/Card/ResourceCard';
import { styled } from 'styled-components';
import { TableRTE } from '../TableRTE';

const stopPropagation = (e: React.MouseEvent<HTMLDivElement>) =>
  e.stopPropagation();

export const ResourceComponent = (
  props: ReactNodeViewProps<HTMLDivElement>,
) => {
  const resource = useResource(props.node.attrs.subject);

  const Component = resource.matchClass(
    {
      [dataBrowser.classes.table]: TableRTE,
    },
    ResourceCard,
  );

  return (
    <StyledNodeViewWrapper
      onClick={stopPropagation}
      onMouseDown={stopPropagation}
    >
      <Component subject={props.node.attrs.subject} />
    </StyledNodeViewWrapper>
  );
};

const StyledNodeViewWrapper = styled(NodeViewWrapper)`
  margin-bottom: 1rem;
`;

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
  color: ${props => props.theme.colors.mainSelectedFg};
  background-color: ${props => props.theme.colors.mainSelectedBg};
  padding: 0rem 0.4rem;
  border-radius: ${props => props.theme.radius};
  border: 1px solid ${props => props.theme.colors.mainSelectedFg};
  user-select: none;
`;
