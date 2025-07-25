import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  useResource,
  useCanWrite,
  unknownSubject,
} from '@tomic/react';
import { useChildren } from '../useChildren';
import { useCurrentSubject } from '../../../helpers/useCurrentSubject';
import { SideBarItem } from '../SideBarItem';
import { AtomicLink } from '../../AtomicLink';
import { styled } from 'styled-components';
import { Details } from '../../Details';
import { errorLookStyle } from '../../ErrorLook';
import { LoaderInline } from '../../Loader';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { useDraggable } from '@dnd-kit/core';
import { SidebarItemTitle } from './SidebarItemTitle';
import { TextWrapper } from './shared';
import { DropEdge } from './DropEdge';
import { SideBarDragData } from '../useSidebarDnd';
import { transparentize } from 'polished';
import { transition } from '../../../helpers/transition';

interface ResourceSideBarProps {
  subject: string;
  renderedHierarchy: string[];
  ancestry: string[];
  /** When a SideBar item is clicked, we should close the SideBar (on mobile devices) */
  onClick?: () => unknown;
}

/** Renders a Resource as a nav item for in the sidebar. */
export const ResourceSideBar: React.FC<ResourceSideBarProps> = ({
  subject,
  renderedHierarchy,
  ancestry,
  onClick,
}) => {
  if (renderedHierarchy.length === 0) {
    throw new Error('renderedHierarchy should not be empty');
  }

  const resource = useResource(subject, { allowIncomplete: true });
  const [currentUrl] = useCurrentSubject();
  const canWrite = useCanWrite(resource);
  const active = currentUrl === subject;
  const [open, setOpen] = useState(active);

  const subResources = useChildren(subject);

  const dragData: SideBarDragData = {
    renderedUnder: renderedHierarchy.at(-1)!,
  };

  const {
    setNodeRef,
    listeners,
    attributes,
    over,
    active: draggingNode,
  } = useDraggable({
    id: subject,
    data: dragData,
    disabled: !canWrite,
  });

  const hasSubResources = subResources.length > 0;

  const toggleExpanded = useCallback(() => setOpen(prev => !prev), []);

  const TitleComp = useMemo(
    () => (
      <SidebarItemTitle
        subject={subject}
        active={active}
        onClick={onClick}
        ref={setNodeRef}
        listeners={canWrite ? listeners : undefined}
        attributes={canWrite ? attributes : undefined}
        expandable={hasSubResources}
        expanded={open}
        onToggleExpand={hasSubResources ? toggleExpanded : undefined}
      />
    ),
    [
      subject,
      active,
      onClick,
      listeners,
      attributes,
      canWrite,
      setNodeRef,
      hasSubResources,
      open,
      toggleExpanded,
    ],
  );
  const isDragging = draggingNode?.id === subject;
  const isHoveringOver = over?.data.current?.parent === subject;
  const hierarchyWithItself = [...renderedHierarchy, subject];

  useEffect(() => {
    if (isDragging) {
      setOpen(false);
    }
  }, [isDragging]);

  useEffect(() => {
    if (ancestry.includes(subject) && ancestry[0] !== subject) {
      setOpen(true);
    }
  }, [ancestry, subject]);

  if (!subject || subject === unknownSubject) {
    return null;
  }

  if (resource.loading) {
    return (
      <TreeLoadingRow
        onClick={onClick}
        disabled={active}
        resource={subject}
        title={`${subject} is loading...`}
      >
        <LoaderInline />
      </TreeLoadingRow>
    );
  }

  if (resource.error) {
    return (
      <StyledLink subject={subject} clean>
        <TreeLoadingRow onClick={onClick} disabled={active} resource={subject}>
          <SideBarErrorWrapper>
            <FaTriangleExclamation />
            Resource with error
          </SideBarErrorWrapper>
        </TreeLoadingRow>
      </StyledLink>
    );
  }

  return (
    <Wrapper highlight={isHoveringOver}>
      <Details
        initialState={open}
        open={open}
        disabled={!hasSubResources}
        onStateToggle={setOpen}
        data-test='resource-sidebar'
        summaryCaret={false}
        title={TitleComp}
      >
        <DropEdge parentHierarchy={hierarchyWithItself} position={0} />
        {hasSubResources &&
          subResources.map((child, index) => (
            <Fragment key={child}>
              <ResourceSideBar
                subject={child}
                renderedHierarchy={hierarchyWithItself}
                ancestry={ancestry}
                onClick={onClick}
              />
              <DropEdge
                parentHierarchy={hierarchyWithItself}
                position={index + 1}
              />
            </Fragment>
          ))}
      </Details>
    </Wrapper>
  );
};

const Wrapper = styled.div<{ highlight: boolean }>`
  background-color: ${p =>
    p.highlight ? transparentize(0.9, p.theme.colors.main) : 'none'};

  border-radius: ${({ theme }) => theme.radius};
  ${transition('background-color')}
`;

const TreeLoadingRow = styled(SideBarItem)`
  box-sizing: border-box;
  width: 100%;
`;

const StyledLink = styled(AtomicLink)`
  box-sizing: border-box;
  display: block;
  width: 100%;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
`;

const SideBarErrorWrapper = styled(TextWrapper)`
  margin-left: 1.3rem;
  ${errorLookStyle}
`;
