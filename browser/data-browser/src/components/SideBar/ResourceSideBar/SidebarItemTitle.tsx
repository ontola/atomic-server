import { forwardRef, memo } from 'react';
import { styled, css, keyframes } from 'styled-components';
import { SideBarItem } from '../SideBarItem';
import { FloatingActions, floatingHoverStyles } from './FloatingActions';
import { getIconForClass } from '../../../helpers/iconMap';
import { useResource, useArray, core, useString } from '@tomic/react';
import { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import { DraggableAttributes } from '@dnd-kit/core';
import { StyledLink, TextWrapper } from './shared';
import {
  SIDEBAR_TRANSITION_TAG,
  getTransitionName,
} from '../../../helpers/transitionName';
import { useSettings } from '../../../helpers/AppSettings';
import { IconButton } from '../../IconButton/IconButton';
import { FaCaretRight, FaGripVertical } from 'react-icons/fa6';
import { UnsavedIndicator } from '../../UnsavedIndicator';

interface SidebarItemTitleProps {
  subject: string;
  active?: boolean;
  listeners?: SyntheticListenerMap;
  attributes?: DraggableAttributes;
  hideActionButtons?: boolean;
  isDragging?: boolean;
  onClick?: () => unknown;
  /** When true, expand caret is shown in the class-icon slot (Details summary has no separate caret). */
  expandable?: boolean;
  expanded?: boolean;
  /** Toggle folder open (separate from navigation link hover). */
  onToggleExpand?: () => void;
}

const NavResourceLink = styled(StyledLink)`
  display: flex;
  align-self: stretch;
`;

export const SidebarItemTitle = memo(
  forwardRef<HTMLAnchorElement, SidebarItemTitleProps>(
    (
      {
        subject,
        active,
        listeners,
        attributes,
        hideActionButtons,
        isDragging,
        onClick,
        expandable = false,
        expanded = false,
        onToggleExpand,
      },
      ref,
    ): React.JSX.Element => {
      const resource = useResource(subject);
      const { sidebarKeyboardDndEnabled } = useSettings();
      const [classType] = useArray(resource, core.properties.isA);
      const [description] = useString(resource, core.properties.description);
      const Icon = getIconForClass(classType[0]!);

      const expandLabel = expanded ? 'Collapse folder' : 'Expand folder';

      return (
        <ActionWrapper
          isDragging={isDragging}
          data-sidebar-id={getTransitionName(SIDEBAR_TRANSITION_TAG, subject)}
        >
          {sidebarKeyboardDndEnabled ? (
            expandable ? (
              <>
                <ExpandToggleButton
                  type='button'
                  aria-expanded={expanded}
                  aria-label={expandLabel}
                  title={`Rearrange ${resource.title}`}
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleExpand?.();
                  }}
                  {...(listeners ?? {})}
                  {...(attributes ?? {})}
                >
                  <ExpandCaret $open={expanded} />
                </ExpandToggleButton>
                <RowBody>
                  <NavResourceLink subject={subject} clean ref={ref}>
                    <ResourceLinkSideBarItem
                      onClick={onClick}
                      disabled={active}
                      resource={subject}
                      title={description}
                    >
                      <TextWrapper>
                        <TreeRowTitle>{resource.title}</TreeRowTitle>
                        <UnsavedIndicator resource={resource} />
                      </TextWrapper>
                    </ResourceLinkSideBarItem>
                  </NavResourceLink>
                </RowBody>
              </>
            ) : (
              <NavResourceLink subject={subject} clean ref={ref}>
                <ResourceTreeRow
                  onClick={onClick}
                  disabled={active}
                  resource={subject}
                  title={description}
                >
                  <TextWrapper>
                    <StyledIconButton
                      title={`Rearange ${resource.title}`}
                      {...(listeners ?? {})}
                      {...(attributes ?? {})}
                      role='link'
                    >
                      <Icon />
                      <FaGripVertical />
                    </StyledIconButton>
                    <TreeRowTitle>{resource.title}</TreeRowTitle>
                    <UnsavedIndicator resource={resource} />
                  </TextWrapper>
                </ResourceTreeRow>
              </NavResourceLink>
            )
          ) : expandable ? (
            <>
              <ExpandToggleButton
                type='button'
                aria-expanded={expanded}
                aria-label={expandLabel}
                title={expandLabel}
                onClick={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleExpand?.();
                }}
              >
                <ExpandCaret $open={expanded} />
              </ExpandToggleButton>
              <RowBody>
                <NavResourceLink
                  subject={subject}
                  clean
                  ref={ref}
                  {...(listeners ?? {})}
                  {...(attributes ?? {})}
                >
                  <ResourceLinkSideBarItem
                    onClick={onClick}
                    disabled={active}
                    resource={subject}
                    title={description}
                  >
                    <TextWrapper>
                      <TreeRowTitle>{resource.title}</TreeRowTitle>
                      <UnsavedIndicator resource={resource} />
                    </TextWrapper>
                  </ResourceLinkSideBarItem>
                </NavResourceLink>
              </RowBody>
            </>
          ) : (
            <NavResourceLink
              subject={subject}
              clean
              ref={ref}
              {...(listeners ?? {})}
              {...(attributes ?? {})}
            >
              <ResourceTreeRow
                onClick={onClick}
                disabled={active}
                resource={subject}
                title={description}
              >
                <TextWrapper>
                  <LeadingSlot>
                    <Icon />
                  </LeadingSlot>
                  <TreeRowTitle>{resource.title}</TreeRowTitle>
                  <UnsavedIndicator resource={resource} />
                </TextWrapper>
              </ResourceTreeRow>
            </NavResourceLink>
          )}
          {!hideActionButtons && (
            <FloatingActionsCell>
              <FloatingActions subject={subject} />
            </FloatingActionsCell>
          )}
        </ActionWrapper>
      );
    },
  ),
);

SidebarItemTitle.displayName = 'SidebarItemTitle';

const lift = keyframes`
  from {
    box-shadow: var(--aw-box-shadow-start);
    scale: 0.9;
  } to {
    box-shadow: var(--aw-box-shadow-end);
    scale: 1;
  }
`;

const StyledIconButton = styled(IconButton)`
  --button-padding: 0;
`;

/** Same width as expand control so class icons line up with carets. */
const LeadingSlot = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.5rem;
`;

const TreeRowTitle = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

/** Same box model as {@link SideBarItem}: padded cell for the 1.5rem leading slot. */
const ExpandToggleButton = styled.button`
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  min-height: ${p => p.theme.margin * 0.5 + 1}rem;
  width: calc(1.5rem + 0.4rem);
  margin: 0;
  padding: 0.2rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background: transparent;
  cursor: pointer;
  color: ${p => p.theme.colors.main};

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
  }

  &:active {
    background-color: ${p => p.theme.colors.bg2};
  }

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: 1px;
  }
`;

const ExpandCaret = styled(FaCaretRight)<{ $open: boolean }>`
  flex-shrink: 0;
  transition: transform ${p => p.theme.animation.duration} ease-in-out;
  transform: rotate(${p => (p.$open ? '90deg' : '0deg')});
  font-size: 0.8rem;
`;

const RowBody = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
`;

/** Fills {@link RowBody} so hover/background spans the sidebar (minus caret + actions). */
const ResourceTreeRow = styled(SideBarItem)`
  flex: 1;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  align-self: stretch;
`;

const ResourceLinkSideBarItem = ResourceTreeRow;

const FloatingActionsCell = styled.span`
  align-self: center;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
`;

const ActionWrapper = styled.div<{ isDragging?: boolean }>`
  --aw-box-shadow-start: 0 0 0 0px rgba(0, 0, 0, 0.1);
  --aw-box-shadow-end:
    0 0 0 1px ${p => p.theme.colors.main}, ${p => p.theme.boxShadowSoft};

  box-sizing: border-box;
  display: flex;
  align-items: stretch;
  width: 100%;
  min-width: 0;
  gap: 0;
  ${floatingHoverStyles}
  border-radius: ${p => p.theme.radius};
  ${p =>
    p.isDragging &&
    css`
      animation: ${lift} 0.2s ease-in-out forwards;
      opacity: 0.9;
    `}

  ${StyledIconButton} svg:last-of-type {
    display: none;
    visibility: hidden;
  }

  &:focus-within,
  &:hover {
    ${StyledIconButton} svg:first-of-type {
      display: none;
      visibility: hidden;
    }
    ${StyledIconButton} svg:last-of-type {
      display: block;
      visibility: visible;
      cursor: grab;
    }
  }
`;
