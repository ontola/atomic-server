/**
 * The handful of colours that are selected **by name at runtime**.
 *
 * Everything else in the app names its colour in CSS, as a token. This map
 * exists for `IconButton`, whose `color` prop is part of its public API — a
 * caller writes `color='alert'`, so the name has to survive into JS. Keep it
 * to colours that are genuinely passed as props; it is not a replacement for
 * the theme object, and adding to it to avoid writing `var(--token)` in CSS
 * puts the drift back.
 */
export const colorTokens = {
  main: 'var(--color-accent)',
  alert: 'var(--color-alert)',
  textLight: 'var(--color-text-subtle)',
  text: 'var(--color-text)',
} as const;

export type ColorTokenName = keyof typeof colorTokens;
