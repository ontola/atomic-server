import { styled, css } from 'styled-components';
import {
  useResource,
  useString,
  useTitle,
  useArray,
  useStore,
  useCanWrite,
  Resource,
  core,
  server,
  dataBrowser,
} from '@tomic/react';
import { constructOpenURL } from '../helpers/navigation';
import { Row } from './Row';
import {
  useNavigateWithTransition,
  useBackForward,
} from '../hooks/useNavigateWithTransition';
import { useSettings } from '../helpers/AppSettings';
import { Button } from './Button';
import { BREADCRUMB_BAR_TRANSITION_TAG } from '../helpers/transitionName';
import { ResourceContextMenu } from './ResourceContextMenu';
import { ParentContextMenuTrigger } from './ResourceContextMenu/ParentContextMenuTrigger';
import {
  FaArrowLeft,
  FaArrowRight,
  FaBars,
  FaMagnifyingGlass,
  FaShare,
  FaTags,
} from 'react-icons/fa6';
import * as RadixPopover from '@radix-ui/react-popover';
import type { JSX } from 'react';
import { useState, useEffect, useMemo } from 'react';
import { useAISidebar } from './AI/AISidebarContext';
import { AIIcon } from './AI/AIIcon';
import { useAISettings } from './AI/AISettingsContext';
import { TagSelectPopover } from './Tag/TagSelectPopover';
import { Tag } from './Tag/Tag';
import { getResourcesDrive } from '@helpers/getResourcesDrive';
import { ShareDialog } from './Share/ShareDialog';
import { IconButton } from './IconButton/IconButton';
import { shortcuts } from './HotKeyWrapper';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { isRunningInTauri } from '../helpers/tauri';
import { openSearchOverlay } from './OverlayContainer';

export type NavBarProps = {
  resource?: Resource;
};

/** Tag select popover wrapper - needs to be separate component to use hooks */
function TagSelectPopoverWrapper({ resource }: { resource: Resource }) {
  const store = useStore();
  const [driveSubject, setDriveSubject] = useState<string>();
  const drive = useResource(driveSubject);
  const [driveTags, setDriveTags] = useArray(
    drive,
    dataBrowser.properties.tagList,
    { commit: true },
  );
  const [tags, setTags] = useArray(resource, dataBrowser.properties.tags, {
    commit: true,
  });
  const canCreateTags = useCanWrite(drive);

  useEffect(() => {
    getResourcesDrive(resource, store).then(setDriveSubject);
  }, [resource, store]);

  const handleNewTag = (newTag: string) => {
    setDriveTags([...driveTags, newTag]);
  };

  if (driveSubject === undefined || resource.loading) {
    return (
      <TagsButton disabled>
        <FaTags />
        <span>Tags</span>
      </TagsButton>
    );
  }

  return (
    <>
      <TagSelectPopover
        tags={driveTags}
        selectedTags={tags}
        setSelectedTags={setTags}
        onNewTag={canCreateTags ? handleNewTag : undefined}
        newTagParent={canCreateTags ? driveSubject : undefined}
        Trigger={
          <TagsButton as={RadixPopover.Trigger}>
            <FaTags />
            <span>Tags</span>
            {tags.length > 0 && <TagsCount>+{tags.length}</TagsCount>}
          </TagsButton>
        }
      />
      {tags.length > 0 && (
        <InlineTagsRow>
          {tags.map(t => (
            <TagPageLink key={t} subject={t} />
          ))}
        </InlineTagsRow>
      )}
    </>
  );
}

/** Shows a "Set drive" button if the current drive is different from the Subject */
function DriveMismatch({ subject }: { subject: string }) {
  const { drive, setDrive } = useSettings();
  const resource = useResource(subject, { allowIncomplete: true });
  const [title] = useTitle(resource);
  const classes = resource.getClasses();

  const handleSetDrive = () => {
    setDrive(subject);
  };

  const mismatch = subject && subject !== drive;

  if (mismatch && classes[0] === server.classes.drive) {
    return (
      <Button
        title={`Set ${title} as current drive`}
        subtle
        onClick={handleSetDrive}
      >
        Set Drive
      </Button>
    );
  }

  return null;
}

/** Direct parent breadcrumb only */
function DirectParent({ subject }: { subject: string }): JSX.Element {
  const resource = useResource(subject, { allowIncomplete: true });
  const [title] = useTitle(resource);
  const navigate = useNavigateWithTransition();

  const handleClick: React.MouseEventHandler<HTMLAnchorElement> = e => {
    e.preventDefault();
    navigate(constructOpenURL(subject));
  };

  return (
    <>
      <DriveMismatch subject={subject} />
      <Breadcrumb href={subject} onClick={handleClick}>
        {title}
      </Breadcrumb>
      <Divider>/</Divider>
    </>
  );
}

/** A tag chip that links to the tag's page */
function TagPageLink({ subject }: { subject: string }): JSX.Element {
  const navigate = useNavigateWithTransition();

  const handleClick: React.MouseEventHandler<HTMLAnchorElement> = e => {
    e.preventDefault();
    navigate(constructOpenURL(subject));
  };

  return (
    <TagAnchor href={constructOpenURL(subject)} onClick={handleClick}>
      <Tag subject={subject} />
    </TagAnchor>
  );
}

/** Breadcrumb list and actions bar */
export function NavBar({ resource: resourceProp }: NavBarProps): JSX.Element {
  const { drive, sideBarLocked, setSideBarLocked } = useSettings();
  const driveResource = useResource(drive);

  const resource =
    resourceProp &&
    resourceProp.subject &&
    resourceProp.subject !== 'unknown-subject'
      ? resourceProp
      : driveResource;

  const [parent] = useString(resource, core.properties.parent);
  const { enableAI } = useAISettings();
  const { setIsOpen } = useAISidebar();
  const { back, forward } = useBackForward();
  const [title] = useTitle(resource);

  const machesStandalone = useMediaQuery(
    '(display-mode: standalone) or (display-mode: fullscreen)',
  );

  const isInStandaloneMode = useMemo<boolean>(
    () =>
      machesStandalone ||
      // @ts-expect-error standalone is available on the navigator object.
      window.navigator.standalone ||
      document.referrer.includes('android-app://') ||
      isRunningInTauri(),
    [machesStandalone],
  );

  return (
    <NavBarWrapper aria-label='Breadcrumbs'>
      <IconButton
        color='textLight'
        type='button'
        onClick={() => setSideBarLocked(!sideBarLocked)}
        title={`Show / hide sidebar (${shortcuts.sidebarToggle})`}
        data-test='sidebar-toggle'
      >
        <FaBars />
      </IconButton>
      {isInStandaloneMode && (
        <>
          <IconButton
            color='textLight'
            type='button'
            title='Go back'
            onClick={back}
          >
            <FaArrowLeft />
          </IconButton>
          <IconButton
            color='textLight'
            type='button'
            title='Go forward'
            onClick={forward}
          >
            <FaArrowRight />
          </IconButton>
        </>
      )}
      <IconButton
        color='textLight'
        type='button'
        title={`Search (${shortcuts.search})`}
        onClick={() => openSearchOverlay()}
      >
        <FaMagnifyingGlass />
      </IconButton>
      <VerticalDivider />
      {parent && <DirectParent subject={parent} />}
      <BreadCrumbCurrent>{title}</BreadCrumbCurrent>
      <Spacer />
      <ButtonArea>
        <ShareDialog
          subject={resource.subject}
          trigger={
            <LabelButton as='button'>
              <FaShare />
              <span>Share</span>
            </LabelButton>
          }
        />
        {enableAI && (
          <LabelButton onClick={() => setIsOpen(prev => !prev)}>
            <AIIcon />
            <span>AI</span>
          </LabelButton>
        )}
        <TagSelectPopoverWrapper resource={resource} />
        <ResourceContextMenu
          isMainMenu
          subject={resource.subject}
          trigger={ParentContextMenuTrigger}
        />
      </ButtonArea>
    </NavBarWrapper>
  );
}

const NavBarWrapper = styled.nav`
  height: 100%;
  width: 100%;
  padding-inline: ${p => p.theme.size(1)};
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;

  view-transition-name: ${BREADCRUMB_BAR_TRANSITION_TAG};

  container: breadcrumb-bar / inline-size;

  @media print {
    display: none;
  }
`;

const VerticalDivider = styled.div`
  width: 1px;
  background-color: ${props => props.theme.colors.bg2};
  height: 1.5rem;
  margin-inline: ${p => p.theme.size(1)};
`;

const Spacer = styled.span`
  flex: 1;
`;

const ButtonArea = styled.div`
  display: flex;
  margin-left: auto;
  color: ${p => p.theme.colors.textLight};
  gap: ${p => p.theme.size(1)};
  align-items: center;

  /* Icon-only mode on small screens */
  @container breadcrumb-bar (max-width: 600px) {
    & > * > span {
      display: none;
    }
  }
`;

const LabelButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  padding: 0.25rem 0.5rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background: transparent;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  font-size: 0.875rem;

  &:hover {
    background: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }
`;

const TagsButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  padding: 0.25rem 0.5rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background: transparent;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  font-size: 0.875rem;

  &:hover {
    background: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }
`;

/** Tag chips row — visible on wide, hidden on narrow */
const InlineTagsRow = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
  font-size: 0.75rem;

  @container breadcrumb-bar (max-width: 600px) {
    display: none;
  }
`;

const TagAnchor = styled.a`
  text-decoration: none;
  display: contents;
`;

/** "+N" badge inside the Tags button — uses <b> to avoid ButtonArea's span-hiding rule */
const TagsCount = styled.b`
  font-weight: inherit;
  font-size: 0.75em;
  opacity: 0.7;

  @container breadcrumb-bar (min-width: 601px) {
    display: none;
  }
`;

const Divider = styled.div`
  padding: 0.1rem 0.2rem;
`;

const BreadCrumbBase = css`
  font-size: ${props => props.theme.fontSizeBody}rem;
  font-family: ${props => props.theme.fontFamily};
  padding: 0.1rem 0.5rem;
  color: ${p => p.theme.colors.textLight};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
`;

const BreadCrumbCurrent = styled.span`
  ${BreadCrumbBase}
`;

const Breadcrumb = styled.a`
  ${BreadCrumbBase}
  align-self: center;
  cursor: pointer;
  text-decoration: none;
  border-radius: ${p => p.theme.radius};

  &:hover {
    background: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }

  &:active {
    background: ${p => p.theme.colors.bg2};
  }
`;

export default NavBar;
