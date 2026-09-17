import { styled } from 'styled-components';
import { transition } from '../helpers/transition';

/**
 * A flat top-bar action button (Share, Comments, AI, Meet). Shared so the
 * meeting button matches the others exactly. When its sidebar panel is open,
 * `$active` tints it with the theme's main color — the same "current item"
 * cue the left sidebar uses — over a subtle background so the toggled-on
 * state reads clearly.
 */
export const LabelButton = styled.button<{ $active?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  padding: 0.25rem 0.5rem;
  /* Same height as the bar's IconButtons so every hover shape is the same
   * rounded square. */
  height: 2rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background: ${p => (p.$active ? p.theme.colors.bg1 : 'transparent')};
  color: ${p => (p.$active ? p.theme.colors.main : p.theme.colors.textLight)};
  cursor: pointer;
  font-size: 0.875rem;
  white-space: nowrap;
  ${transition('background-color', 'color')}

  /* Icons at the same size as the bar's IconButtons, while labels stay
   * slightly smaller than body text. */
  svg {
    font-size: 1rem;
  }

  &[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &:not([disabled]) {
    &:hover,
    &:focus-visible {
      background: ${p => p.theme.colors.bg1};
      color: ${p => (p.$active ? p.theme.colors.main : p.theme.colors.text)};
    }

    &:active {
      background: ${p => p.theme.colors.bg2};
    }
  }
`;
