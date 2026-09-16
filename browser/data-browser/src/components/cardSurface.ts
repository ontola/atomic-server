import { css, styled } from 'styled-components';

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
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  min-width: 0;
`;

/**
 * Type scale for anything sitting on a {@link cardSurface}.
 *
 * Shared as values rather than as components because the wrapping rules
 * legitimately differ — a connection row is one ellipsised line, a panel's
 * description is a paragraph — while the sizes should not.
 */
export const CARD_ICON_SIZE = '2.5rem';
export const CARD_ICON_FONT = 'var(--font-size-lg)';
export const CARD_TITLE_FONT = 'var(--font-size-base)';
export const CARD_SUB_FONT = 'var(--font-size-sm)';
/** Between title and subtitle: they read as one block. */
export const CARD_BODY_GAP = 'var(--space-1)';
export const CARD_ACTIONS_GAP = 'var(--space-2)';

/**
 * The round glyph chip on a {@link cardSurface}.
 *
 * One component with exactly two tones, because there were three separate
 * implementations of this circle — one per card family — and they had drifted:
 * a device chip was light grey with a dark glyph while a server chip was dark
 * grey with a white one, so two things in the same category looked like two
 * categories. Anything that reads as a distinction here should be a real one.
 *
 * The only real one left is whether the service is on. Blue means this is one
 * of ours *and* it is running for you. Neutral covers everything else: an offer
 * we have not sold yet, a service still being checked, one that failed to
 * answer, and a self-hosted node, which is somebody else's box however live it
 * happens to be.
 *
 * Blue for "ours, but only on offer" reads fine on a single card and badly in a
 * list, which is what the Sync page is. In a column of these, the tier you pay
 * for and the one you merely could buy looked identical, so the glyph answered
 * "does this product exist" when the only question being asked of it was "do I
 * have this". The account header is the one blue that is not a service: being
 * connected to the provider is the state it reports.
 */
export const CardIcon = styled.div<{ $tone?: 'neutral' | 'provider' }>`
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: ${CARD_ICON_SIZE};
  height: ${CARD_ICON_SIZE};
  border-radius: var(--radius-full);
  font-size: ${CARD_ICON_FONT};
  color: ${p =>
    p.$tone === 'provider' ? 'var(--color-on-accent)' : 'var(--color-text)'};
  background: ${p =>
    p.$tone === 'provider' ? 'var(--color-accent)' : 'var(--color-bg-active)'};
`;
