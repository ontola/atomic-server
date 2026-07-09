import { styled } from 'styled-components';

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
  border: none;
  border-radius: ${p => p.theme.radius};
  background: ${p => (p.$active ? p.theme.colors.bg1 : 'transparent')};
  color: ${p => (p.$active ? p.theme.colors.main : p.theme.colors.textLight)};
  cursor: pointer;
  font-size: 0.875rem;
  white-space: nowrap;

  &:hover,
  &:focus-visible {
    background: ${p => p.theme.colors.bg1};
    color: ${p => (p.$active ? p.theme.colors.main : p.theme.colors.text)};
  }
`;
