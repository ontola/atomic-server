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
import { constructOpenURL, shareURL } from '../helpers/navigation';
import { Row } from './Row';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { useSettings } from '../helpers/AppSettings';
import { Button } from './Button';
import { BREADCRUMB_BAR_TRANSITION_TAG } from '../helpers/transitionName';
import { ResourceContextMenu } from './ResourceContextMenu';
import { MenuBarDropdownTrigger } from './ResourceContextMenu/MenuBarDropdownTrigger';
import { FaMagnifyingGlass, FaShare, FaTags } from 'react-icons/fa6';
import { ResourceInline } from '../views/ResourceInline';
import type { JSX } from 'react';
import { useState, useEffect } from 'react';
import { useAISidebar } from './AI/AISidebarContext';
import { AIIcon } from './AI/AIIcon';
import { useAISettings } from './AI/AISettingsContext';
import { openSearchOverlay } from './OverlayContainer';
import { TagSelectPopover } from './Tag/TagSelectPopover';
import { getResourcesDrive } from '@helpers/getResourcesDrive';
import * as RadixPopover from '@radix-ui/react-popover';
import { SkeletonButton } from './SkeletonButton';

type ParentProps = {
  resource: Resource;
};

/** Tag select popover wrapper - needs to be a separate component to use hooks */
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
        </TagsButton>
      }
    />
  );
}

/** Breadcrumb list. Recursively renders parents. */
function Parent({ resource }: ParentProps): JSX.Element {
  const [parent] = useString(resource, core.properties.parent);
  const { enableAI } = useAISettings();
  const { setIsOpen } = useAISidebar();
  const navigate = useNavigateWithTransition();
  const [tags] = useArray(resource, dataBrowser.properties.tags);

  return (
    <ParentWrapper aria-label='Breadcrumbs'>
      {!parent && <DriveMismatch subject={resource.subject} />}
      <BreadcrumbRow center gap='initial'>
        {parent && <NestedParent subject={parent} depth={0} />}
        <BreadCrumbCurrent>{resource.title}</BreadCrumbCurrent>
      </BreadcrumbRow>
      <Spacer />
      <ButtonArea>
        <LabelButton onClick={() => openSearchOverlay()}>
          <FaMagnifyingGlass />
          <span>Search</span>
        </LabelButton>
        <LabelButton onClick={() => navigate(shareURL(resource.subject))}>
          <FaShare />
          <span>Share</span>
        </LabelButton>
        {enableAI && (
          <LabelButton onClick={() => setIsOpen(prev => !prev)}>
            <AIIcon />
            <span>AI</span>
          </LabelButton>
        )}
        <TagSelectPopoverWrapper resource={resource} />
        {tags.length > 0 && (
          <SelectedTagsRow>
            {tags.map(tag => (
              <SmallTag key={tag}>
                <ResourceInline subject={tag} />
              </SmallTag>
            ))}
          </SelectedTagsRow>
        )}
        <ResourceContextMenu
          isMainMenu
          subject={resource.subject}
          trigger={MenuBarDropdownTrigger}
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

  @media print {
    display: none;
  }
`;

const BreadcrumbRow = styled(Row)`
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  max-width: 80vw;
  & > * {
    min-width: 0;
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

  @container (max-width: 600px) {
    span {
      display: none;
    }
  }
`;

const SelectedTagsRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${p => p.theme.size(1)};
  flex-wrap: wrap;
`;

const SmallTag = styled.span`
  font-size: 0.75rem;
  opacity: 0.8;
`;

type NestedParentProps = {
  subject: string;
  depth: number;
};

const MAX_BREADCRUMB_DEPTH = 4;

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

/** The actually recursive part */
function NestedParent({ subject, depth }: NestedParentProps): JSX.Element {
  const resource = useResource(subject, { allowIncomplete: true });
  const [parent] = useString(resource, core.properties.parent);
  const navigate = useNavigateWithTransition();
  const [title] = useTitle(resource);

  // Prevent infinite recursion, set a limit to parent breadcrumbs
  if (depth > MAX_BREADCRUMB_DEPTH) {
    return <Breadcrumb>Set as drive</Breadcrumb>;
  }

  const handleClick: React.MouseEventHandler<HTMLAnchorElement> = e => {
    e.preventDefault();
    navigate(constructOpenURL(subject));
  };

  return (
    <>
      {parent ? (
        <NestedParent subject={parent} depth={depth + 1} />
      ) : (
        <DriveMismatch subject={subject} />
      )}
      <Breadcrumb href={subject} onClick={handleClick}>
        {title}
      </Breadcrumb>
      <Divider>{'/'}</Divider>
    </>
  );
}

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
