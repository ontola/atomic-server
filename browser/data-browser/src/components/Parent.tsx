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
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { useSettings } from '../helpers/AppSettings';
import { Button } from './Button';
import { BREADCRUMB_BAR_TRANSITION_TAG } from '../helpers/transitionName';
import { ResourceContextMenu } from './ResourceContextMenu';
import { ParentContextMenuTrigger } from './ResourceContextMenu/ParentContextMenuTrigger';
import { FaMagnifyingGlass, FaShare, FaTags } from 'react-icons/fa6';
import * as RadixPopover from '@radix-ui/react-popover';
import type { JSX } from 'react';
import { useState, useEffect } from 'react';
import { useAISidebar } from './AI/AISidebarContext';
import { AIIcon } from './AI/AIIcon';
import { useAISettings } from './AI/AISettingsContext';
import { openSearchOverlay } from './OverlayContainer';
import { TagSelectPopover } from './Tag/TagSelectPopover';
import { Tag } from './Tag/Tag';
import { getResourcesDrive } from '@helpers/getResourcesDrive';
import { ShareDialog } from './Share/ShareDialog';

type ParentProps = {
  resource: Resource;
};

/** Tag select popover wrapper - needs to be separate component to use hooks */
function TagSelectPopoverWrapper({ resource }: { resource: Resource }) {
  const store = useStore();
  const [driveSubject, setDriveSubject] = useState<string>();
  const drive = useResource(driveSubject);
  const [driveTags, , pushDriveTags] = useArray(
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
    pushDriveTags([newTag]);
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

/** Breadcrumb list */
function Parent({ resource }: ParentProps): JSX.Element {
  const [parent] = useString(resource, core.properties.parent);
  const { enableAI } = useAISettings();
  const { setIsOpen } = useAISidebar();

  return (
    <ParentWrapper aria-label='Breadcrumbs'>
      {parent && <DirectParent subject={parent} />}
      <BreadCrumbCurrent>{resource.title}</BreadCrumbCurrent>
      <Spacer />
      <ButtonArea>
        <LabelButton onClick={() => openSearchOverlay()}>
          <FaMagnifyingGlass />
          <span>Search</span>
        </LabelButton>
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
    </ParentWrapper>
  );
}

const ParentWrapper = styled.nav`
  min-height: ${p => p.theme.heights.breadCrumbBar};
  padding-inline: ${p => p.theme.size(2)};
  border-bottom: 1px solid ${props => props.theme.colors.bg2};
  background-color: ${props => props.theme.colors.bg};
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

export default Parent;
