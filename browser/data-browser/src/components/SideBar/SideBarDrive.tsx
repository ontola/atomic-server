import {
  core,
  useArray,
  useCanWrite,
  useResource,
  useStore,
  useTitle,
} from '@tomic/react';
import { Fragment, useEffect, useState, type JSX } from 'react';
import { useChildren } from './useChildren';
import { styled } from 'styled-components';
import { useSettings } from '../../helpers/AppSettings';
import { constructOpenURL } from '../../helpers/navigation';
import { Button } from '../Button';
import { ResourceSideBar } from './ResourceSideBar/ResourceSideBar';
import { SideBarHeader } from './SideBarHeader';
import { SimpleErrorBlock } from '../ErrorLook';
import { DriveSwitcher } from './DriveSwitcher';
import { Row } from '../Row';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { ScrollArea } from '../ScrollArea';
import { useSidebarDnd } from './useSidebarDnd';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { SidebarItemTitle } from './ResourceSideBar/SidebarItemTitle';
import { DropEdge } from './ResourceSideBar/DropEdge';
import { createPortal } from 'react-dom';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { LoaderInline } from '../Loader';
import { SkeletonButton } from '../SkeletonButton';
import { QuickCreateRow } from '../NewInstanceButton';
import { SideBarPanel } from './SideBarPanel';
import { SharedWithMeLink } from './SharedWithMeLink';

interface SideBarDriveProps {
  onItemClick: () => unknown;
  onIsRearangingChange: (isRearanging: boolean) => void;
}

/** Shows the current Drive, it's children and an option to change to a different Drive */
export function SideBarDrive({
  onItemClick,
  onIsRearangingChange,
}: SideBarDriveProps): JSX.Element {
  const store = useStore();
  const { drive, agent } = useSettings();
  const {
    handleDragStart,
    handleDragEnd,
    draggingResource,
    sensors,
    animateDrop,
    dndExplanation,
    announcements,
  } = useSidebarDnd(onIsRearangingChange);
  const driveResource = useResource(drive);
  const agentResource = useResource(agent?.subject);
  const [sharedWithMe] = useArray(agentResource, core.properties.sharedWithMe);
  const { subjects: subResources, loading: childrenLoading } =
    useChildren(drive);
  const [title] = useTitle(driveResource);
  const navigate = useNavigateWithTransition();
  const agentCanWrite = useCanWrite(driveResource);
  const [currentSubject] = useCurrentSubject();
  const currentResource = useResource(currentSubject, {
    track: [core.properties.parent],
  });
  const [ancestry, setAncestry] = useState<string[]>([]);

  useEffect(() => {
    store.getResourceAncestry(currentResource).then(result => {
      setAncestry(result);
    });
  }, [store, currentResource]);

  const driveName = driveResource.isUnauthorized()
    ? 'Unauthorized'
    : title || drive;

  return (
    <>
      <SideBarHeader>
        <TitleButton
          resource={drive}
          clean
          current={drive === currentSubject}
          data-testid='sidebar-drive-open'
          onClick={() => {
            onItemClick();
            navigate(constructOpenURL(drive));
          }}
        >
          <DriveTitle data-testid='current-drive-title'>{driveName}</DriveTitle>
        </TitleButton>
        <HeadingButtonWrapper gap='0'>
          <DriveSwitcher />
        </HeadingButtonWrapper>
      </SideBarHeader>
      <DndContext
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        sensors={sensors}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: dndExplanation,
          },
        }}
      >
        <StyledScrollArea>
          <ListWrapper>
            <DropEdge parentHierarchy={[drive]} position={0} />
            {driveResource.isReady() ? (
              childrenLoading ? (
                <SideBarLoader />
              ) : (
                subResources.map((child, index) => {
                  return (
                    <Fragment key={child}>
                      <ResourceSideBar
                        subject={child}
                        renderedHierarchy={[drive]}
                        ancestry={ancestry}
                        onClick={onItemClick}
                      />
                      <DropEdge
                        parentHierarchy={[drive]}
                        position={index + 1}
                      />
                    </Fragment>
                  );
                })
              )
            ) : driveResource.loading ? null : (
              <SideBarErr>
                {driveResource.error &&
                  (driveResource.isUnauthorized()
                    ? agent
                      ? 'unauthorized'
                      : 'This drive is private, sign in to view it'
                    : driveResource.error.message)}
              </SideBarErr>
            )}
            {agentCanWrite && (
              <NewResourceRow gap='0' center>
                <QuickCreateRow
                  parent={drive}
                  newResourceButtonTestId='sidebar-new-resource'
                  onItemClick={onItemClick}
                />
              </NewResourceRow>
            )}
            {agent && sharedWithMe.length > 0 ? (
              <SideBarPanel
                title='Shared with me'
                embedded
                data-testid='shared-with-me'
              >
                {sharedWithMe.map((subject: string) => (
                  <SharedWithMeLink
                    key={subject}
                    subject={subject}
                    onClick={onItemClick}
                    data-testid='shared-with-me-item'
                  />
                ))}
              </SideBarPanel>
            ) : null}
          </ListWrapper>
        </StyledScrollArea>
        {createPortal(
          <DragOverlay dropAnimation={animateDrop}>
            {draggingResource && (
              <SidebarItemTitle
                subject={draggingResource}
                hideActionButtons
                isDragging
              />
            )}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </>
  );
}

const DriveTitle = styled.h2`
  margin: 0;
  padding: 0;
  font-size: 1.4rem;
  flex: 1;
`;

const TitleButton = styled(Button)<{ current?: boolean }>`
  text-align: left;
  flex: 1;
  padding: 0.5rem ${props => props.theme.margin}rem;
  border-radius: ${props => props.theme.radius};

  ${({ current, theme }) =>
    current &&
    `
    color: ${theme.colors.main};
  `}

  &:hover {
    background-color: ${props => props.theme.colors.bg1};
  }
  &:active {
    background-color: ${props => props.theme.colors.bg2};
  }
`;

const SideBarErr = styled(SimpleErrorBlock)`
  margin-inline-end: ${props => props.theme.size()};
`;

const ListWrapper = styled.div`
  overflow-x: hidden;
  position: relative;
  padding-inline: ${p => p.theme.margin}rem;
`;

const HeadingButtonWrapper = styled(Row)`
  color: ${p => p.theme.colors.main};
  font-size: 0.9rem;
`;

const StyledScrollArea = styled(ScrollArea)`
  overflow: hidden;
`;

const SideBarLoader = styled(LoaderInline)`
  display: block;
  height: 1.5rem;
  margin-block: 0.3rem;
`;

const NewResourceRow = styled(Row)`
  padding-bottom: 1rem;
  overflow: visible;
`;
