import type { JSX } from 'react';
import { css, styled } from 'styled-components';
import type { DropdownTriggerProps } from '../Dropdown/DropdownTrigger';
import { transition } from '../../helpers/transition';

interface FollowingIndicatorProps extends DropdownTriggerProps {
  /** True when this avatar is the agent the signed-in user is following. */
  following: boolean;
  /** Hover/open chip. Only rendered while `following`. */
  label?: string;
  title: string;
  ariaLabel?: string;
  /**
   * Native `<button>` for the navbar. Default is a focusable span so the
   * trigger stays valid markup inside sidebar row links.
   */
  nativeButton?: boolean;
  children: React.ReactNode;
}

/**
 * Shared follow-mode chrome for an avatar trigger (#1486): a blue ring
 * flush with the image while following, expanding into a "Following"
 * chip on hover / keyboard focus / while the actions menu is open.
 * Non-following avatars get the same tight ring on hover as an affordance.
 */
export function FollowingIndicator({
  following,
  label = 'Following',
  title,
  ariaLabel,
  nativeButton = false,
  onClick,
  menuId,
  isActive,
  ref,
  id,
  children,
}: FollowingIndicatorProps): JSX.Element {
  const revealed = following && isActive;
  const chip = following ? (
    <Clip>
      <Label>{label}</Label>
    </Clip>
  ) : null;

  if (nativeButton) {
    return (
      <Frame
        as='button'
        type='button'
        id={id}
        aria-controls={menuId}
        aria-expanded={isActive}
        aria-haspopup='menu'
        aria-label={ariaLabel}
        title={title}
        $following={following}
        $revealed={revealed}
        onClick={onClick}
        ref={ref}
      >
        {chip}
        {children}
      </Frame>
    );
  }

  return (
    <Frame
      id={id}
      role='button'
      tabIndex={0}
      aria-controls={menuId}
      aria-expanded={isActive}
      aria-haspopup='menu'
      aria-label={ariaLabel}
      title={title}
      $following={following}
      $revealed={revealed}
      ref={ref as unknown as React.Ref<HTMLSpanElement>}
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick(e as unknown as React.MouseEvent);
        }
      }}
    >
      {chip}
      {children}
    </Frame>
  );
}

const Clip = styled.span`
  display: block;
  max-width: 0;
  overflow: hidden;
  ${transition('max-width')}
`;

const Label = styled.span`
  display: block;
  color: white;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  padding-inline: 0.45rem 0.3rem;
  opacity: 0;
  ${transition('opacity')}
`;

const revealChip = css`
  background-color: ${p => p.theme.colors.main};

  ${Clip} {
    max-width: 7rem;
  }

  ${Label} {
    opacity: 1;
  }
`;

const Frame = styled.span<{ $following: boolean; $revealed: boolean }>`
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 0;
  cursor: pointer;
  ${transition('background-color')}

  &:hover,
  &:focus-visible {
    z-index: 1;
  }

  ${p =>
    p.$following &&
    css`
      &:hover,
      &:focus-visible {
        ${revealChip}
      }

      ${p.$revealed && revealChip}

      &:focus-visible {
        outline: none;
      }
    `}

  ${p =>
    !p.$following &&
    css`
      &:hover [data-agent-avatar],
      &:focus-visible [data-agent-avatar] {
        border-color: ${p.theme.colors.main};
      }

      &:focus-visible {
        outline: 2px solid ${p.theme.colors.main};
        outline-offset: 2px;
      }
    `}

  @media (prefers-reduced-motion: reduce) {
    transition: none;

    ${Clip}, ${Label} {
      transition: none;
    }
  }
`;
