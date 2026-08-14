import { css } from 'styled-components';

/**
 * The one card surface the Sync page and its panels share.
 *
 * There used to be four of these, all slightly different: the device card had
 * a tinted background and no border, the connection cards had a border and no
 * tint, the Cloud Server card had an accent border *and* an accent tint, and
 * the vault panel had its own padding and gap on top of that. Read as a list —
 * which is how the Sync page presents them — they looked like four kinds of
 * thing rather than four of the same thing.
 *
 * Anything that genuinely differs (which server is live, say) should be a
 * state on top of this, not a separate surface.
 */
export const cardSurface = css`
  display: flex;
  align-items: flex-start;
  gap: 0.9rem;
  padding: 0.9rem 1rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  background: ${p => p.theme.colors.bg};
  min-width: 0;
`;

/**
 * Type scale for anything sitting on a {@link cardSurface}.
 *
 * Shared as values rather than as components because the wrapping rules
 * legitimately differ — a connection row is one ellipsised line, a panel's
 * description is a paragraph — while the sizes should not.
 */
export const CARD_ICON_SIZE = '2.4rem';
export const CARD_ICON_FONT = '1.1rem';
export const CARD_TITLE_FONT = '0.95rem';
export const CARD_SUB_FONT = '0.82rem';
/** Between title and subtitle: they read as one block. */
export const CARD_BODY_GAP = '0.15rem';
export const CARD_ACTIONS_GAP = '0.5rem';
