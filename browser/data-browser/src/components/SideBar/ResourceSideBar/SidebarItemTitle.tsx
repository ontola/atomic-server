import { forwardRef, memo } from 'react';
import { styled, css, keyframes } from 'styled-components';
import { SideBarItem } from '../SideBarItem';
import { FloatingActions, floatingHoverStyles } from './FloatingActions';
import {
  useResource,
  useString,
  useSubject,
  dataBrowser,
  useTitle,
} from '@tomic/react';
import { ResourceGlyph } from '../../ResourceGlyph';
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
import { SidebarPresence } from '../../Presence/SidebarPresence';

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
      const [emoji] = useString(resource, dataBrowser.properties.emoji);
      const [iconImage] = useSubject(resource, dataBrowser.properties.icon);
      // A resource's own icon image or emoji takes precedence over its
      // class icon (the precedence lives in ResourceGlyph).
      const hasCustomGlyph = !!(emoji || iconImage);
      const glyph = (
        <GlyphSlot aria-hidden>
          <ResourceGlyph resource={resource} />
        </GlyphSlot>
      );
      // Reactive title via `useTitle` (subscribes to `name`/`shortname`/
      // `filename` LocalChange events through `useValue`'s
      // `useSyncExternalStore`). Reading the bare `resource.title` getter
      // here would render once at mount and never update — the row only
      // refreshed when navigation forced a top-down re-render, which is
      // the "title only updates when I click in the sidebar" symptom.
      const [title] = useTitle(resource);

      const expandLabel = expanded ? 'Collapse folder' : 'Expand folder';

      // Expandable rows have no icon slot (the caret occupies it), so a
      // custom glyph rests in the caret's place and yields to it on
      // hover/focus — same swap pattern as the drag grip below.
      const expandControl = hasCustomGlyph ? (
        <>
          <GlyphSlot aria-hidden>
            <ResourceGlyph resource={resource} requireCustom />
          </GlyphSlot>
          <ExpandCaret $open={expanded} />
        </>
      ) : (
        <ExpandCaret $open={expanded} />
      );

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
                  title={`Rearrange ${title}`}
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleExpand?.();
                  }}
                  {...(listeners ?? {})}
                  {...(attributes ?? {})}
                >
                  {expandControl}
                </ExpandToggleButton>
                <RowBody>
                  <NavResourceLink subject={subject} clean ref={ref}>
                    <ResourceLinkSideBarItem
                      onClick={onClick}
                      disabled={active}
                      resource={subject}
                    >
                      <TextWrapper>
                        <TreeRowTitle>{title}</TreeRowTitle>
                        <SidebarPresence subject={subject} />
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
                >
                  <TextWrapper>
                    <StyledIconButton
                      title={`Rearange ${title}`}
                      {...(listeners ?? {})}
                      {...(attributes ?? {})}
                      role='link'
                    >
                      {glyph}
                      <FaGripVertical />
                    </StyledIconButton>
                    <TreeRowTitle>{title}</TreeRowTitle>
                    <SidebarPresence subject={subject} />
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
                {expandControl}
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
                  >
                    <TextWrapper>
                      <TreeRowTitle>{title}</TreeRowTitle>
                      <SidebarPresence subject={subject} />
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
              >
                <TextWrapper>
                  <LeadingSlot>{glyph}</LeadingSlot>
                  <TreeRowTitle>{title}</TreeRowTitle>
                  <SidebarPresence subject={subject} />
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

/** Wraps the resource glyph; sized to line up with the svg class icons. */
const GlyphSlot = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  line-height: 1;
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
    /* The glyph (emoji / icon image / class icon, wrapped in GlyphSlot)
       makes way for the drag grip on hover (the svg swap rules above
       only match direct svg children). */
    ${StyledIconButton} ${GlyphSlot} {
      display: none;
    }
    /* Same for the expand caret: the glyph rests in its slot, caret on
       hover. */
    ${ExpandToggleButton} ${GlyphSlot} {
      display: none;
    }
    ${ExpandToggleButton} ${GlyphSlot} + svg {
      display: block;
    }
  }

  ${ExpandToggleButton} ${GlyphSlot} + svg {
    display: none;
  }
`;
