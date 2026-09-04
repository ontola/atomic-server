import { useMediaQuery } from './useMediaQuery';

/**
 * Where the "Add icon" / "Add cover" ghost buttons live next to a page title.
 *
 * They reveal on hover, so they need a hover-capable pointer: on touch they
 * would be invisible yet tappable, and a tap on what looks like empty space
 * beside the title would open a picker. They also sit on the title's row, so
 * they need room; on a phone-width viewport they squeeze the title into
 * wrapping around them. Where either is missing, the same actions surface in
 * the resource context menu instead (see `resourceActions`).
 */
export const INLINE_TITLE_AFFORDANCES_QUERY =
  '(hover: hover) and (min-width: 600px)';

export function useInlineTitleAffordances(): boolean {
  return useMediaQuery(INLINE_TITLE_AFFORDANCES_QUERY);
}
