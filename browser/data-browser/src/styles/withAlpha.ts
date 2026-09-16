/**
 * Alpha on a token.
 *
 * `transparentize(0.2, theme.colors.bg)` used to work because the theme held a
 * colour. Colours are tokens now, and polished cannot parse `var(--color-bg)`
 * — so the blend moves to CSS, where the browser resolves the variable first.
 * `color-mix` in oklab also fades more evenly than an sRGB alpha, because it
 * interpolates perceptually.
 *
 * ```ts
 * background: ${withAlpha('var(--color-bg)', 0.8)};
 * ```
 *
 * @param color Any CSS colour, including a `var(--token)` reference.
 * @param alpha Opacity to keep, 0..1 — the opposite of polished's
 *   `transparentize`, which takes the amount to remove.
 */
export function withAlpha(color: string, alpha: number): string {
  const percentage = Math.round((1 - Math.min(1, Math.max(0, alpha))) * 100);

  return `color-mix(in oklab, ${color}, transparent ${percentage}%)`;
}

/**
 * Blends `amount` of `color` into `base`, the `color-mix` equivalent of
 * polished's `mix`. Use when one of the two colours comes from data (a tag
 * colour, a Kanban column tint) and so cannot be a token.
 */
export function blend(color: string, base: string, amount: number): string {
  const percentage = Math.round(Math.min(1, Math.max(0, amount)) * 100);

  return `color-mix(in oklab, ${color} ${percentage}%, ${base})`;
}
