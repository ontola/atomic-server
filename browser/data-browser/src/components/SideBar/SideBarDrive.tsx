import {
  core,
  dataBrowser,
  useArray,
  useCanWrite,
  useResource,
  useStore,
  useTitle,
} from '@tomic/react';
import { Fragment, useEffect, useState, type JSX } from 'react';
import { FaPlus } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { useSettings } from '../../helpers/AppSettings';
import { constructOpenURL } from '../../helpers/navigation';
import { paths } from '../../routes/paths';
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
import { SkeletonButton } from '../SkeletonButton';

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
  const [subResources] = useArray(
    driveResource,
    dataBrowser.properties.subResources,
  );
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
          title={`Your current baseURL is ${drive}`}
          data-test='sidebar-drive-open'
          onClick={() => {
            onItemClick();
            navigate(constructOpenURL(drive));
          }}
        >
          <DriveTitle data-testid='current-drive-title'>
            {driveName}{' '}
          </DriveTitle>
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
              subResources.map((child, index) => {
                return (
                  <Fragment key={child}>
                    <ResourceSideBar
                      subject={child}
                      renderedHierarchy={[drive]}
                      ancestry={ancestry}
                      onClick={onItemClick}
                    />
                    <DropEdge parentHierarchy={[drive]} position={index + 1} />
                  </Fragment>
                );
              })
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
              <AddButton
                title='New resource'
                data-testid='sidebar-new-resource'
                onClick={() => navigate(paths.new)}
              >
                <FaPlus />
              </AddButton>
            )}
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
  padding: 0.5rem 1rem;
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
  margin-inline-start: ${props => props.theme.size(2)};
  margin-inline-end: ${props => props.theme.size()};
`;

const ListWrapper = styled.div`
  overflow-x: hidden;
  position: relative;
  margin-left: 0.5rem;
`;

const HeadingButtonWrapper = styled(Row)`
  color: ${p => p.theme.colors.main};
  font-size: 0.9rem;
`;

const StyledScrollArea = styled(ScrollArea)`
  overflow: hidden;
`;

const AddButton = styled(SkeletonButton)`
  width: calc(100% - 5rem);
  padding-block: 0.3rem;
  margin-inline-start: 2rem;
  margin-block-start: 0.5rem;
  margin-block-end: 1rem;
`;
