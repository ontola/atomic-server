/**
 * The app's muted main-colour presets: what the appearance settings offer, and
 * the default colours for new tags.
 *
 * Lives beside the token layer rather than in `styling.tsx` so the contrast
 * gate can import it without pulling in styled-components and the global CSS.
 * Every colour here is run through the accent ramp by
 * `tokens.contrast.test.ts`, so adding one means the gate checks it too.
 */
export const presetColors = [
  '#4C6FA5', // dusty blue
  '#6E9B7B', // sage green
  '#CC7B54', // terracotta
  '#B5657A', // dusty rose
  '#CC9A44', // mustard
  '#7C7BB8', // periwinkle
  '#4E9B96', // muted teal
  '#A9825E', // warm taupe
];

/** Used when the stored main colour is missing or unparseable. */
export const DEFAULT_MAIN_COLOR = '#1b50d8';
