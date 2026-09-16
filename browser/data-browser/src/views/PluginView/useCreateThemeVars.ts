import { resolveCssVars } from '../../styles/resolveTokens';

/**
 * Returns a stylesheet that adds all our theme variables to an iframe's document as css variables.
 */
export function useCreateThemeVars() {
  const themeVars: Record<string, string> = {
    '--t-container-width': `var(--container-width)`,
    '--t-container-width-wide': 'var(--container-width-wide)',
    '--t-sidebar-width': `var(--sidebar-width)`,
    '--t-font-family': 'var(--font-family)',
    '--t-font-family-header': 'var(--font-family-heading)',
    '--t-font-size-body': `var(--font-size-base)`,
    '--t-font-size-h1': `var(--font-size-3xl)`,
    '--t-box-shadow': 'var(--elevation-1)',
    '--t-box-shadow-intense': 'var(--elevation-3)',
    '--t-box-shadow-soft': 'var(--elevation-2)',
    '--t-radius': 'var(--radius-md)',
    '--t-height-breadcrumb-bar': 'var(--height-breadcrumb-bar)',
    '--t-height-full-page': '100%',
    '--t-height-floating-search-bar-padding':
      'var(--height-floating-search-bar)',
    '--t-animation-duration': 'var(--duration-fast)',
    // Colors
    '--t-color-main': 'var(--color-accent)',
    '--t-color-main-light': 'var(--color-accent-hover)',
    '--t-color-main-dark': 'var(--color-accent-text)',
    '--t-color-main-selected-bg': 'var(--color-accent-subtle)',
    '--t-color-main-selected-fg': 'var(--color-accent-text)',
    '--t-color-complementary': 'var(--accent-complementary)',
    '--t-color-bg-body': 'var(--color-bg-body)',
    '--t-color-bg': 'var(--color-bg)',
    '--t-color-bg-1': 'var(--color-bg-subtle)',
    '--t-color-bg-2': 'var(--color-border)',
    '--t-color-text': 'var(--color-text)',
    '--t-color-text-1': 'var(--color-text)',
    '--t-color-text-light': 'var(--color-text-subtle)',
    '--t-color-text-light-2': 'var(--color-text-subtle)',
    '--t-color-alert': 'var(--color-alert)',
    '--t-color-alert-light': 'var(--color-alert-subtle)',
    '--t-color-warning': 'var(--color-warning)',
    // Spacing / Sizes
    '--t-size-1': 'var(--space-1)',
    '--t-size-2': 'var(--space-2)',
    '--t-size-3': 'var(--space-3)',
    '--t-size-4': 'var(--space-4)',
    '--t-size-5': 'var(--space-5)',
    '--t-size-6': 'var(--space-6)',
    '--t-size-7': 'var(--space-7)',
    '--t-size-8': 'var(--space-8)',
    '--t-size-9': 'var(--space-9)',
    '--t-size-10': 'var(--space-10)',
    '--t-size-11': 'var(--space-11)',
    '--t-size-12': 'var(--space-12)',
    '--t-size-13': 'var(--space-13)',
    '--t-size-14': 'var(--space-14)',
    '--t-size-15': 'var(--space-15)',
  };

  // The theme now holds `var(--token)` references, and the iframe this
  // stylesheet is injected into has no `:root` carrying them. Resolve on the
  // way out so the plugin gets colours; the `--t-*` contract plugins are
  // written against is unchanged.
  return `
  :root {
    ${Object.entries(themeVars)
      .map(([key, value]) => `${key}: ${resolveCssVars(value)};`)
      .join('\n')}
  }
  * {
  box-sizing: border-box;
    scrollbar-color: var(--t-color-bg-2) transparent;
    @media print {
      scrollbar-color: transparent transparent;
    }
    &::-webkit-scrollbar {
      width: 10px;
      height: 10px;
      padding: 3px;
      background-color: transparent;/* color of the tracking area */

    }
    &::-webkit-scrollbar-thumb {
      width: 8px;
      margin: auto;
      background-color: var(--t-color-bg-2); /* color of the tracking area */
      border-radius: var(--t-radius);

      &:hover {
        background-color: color(from var(--t-color-bg-2) hsl h s calc(l * 0.9));
      }
    }
  }
  body {
    background-color: var(--t-color-bg-body);
    color: var(--t-color-text);
    font-family: var(--t-font-family);
    line-height: 1.5em;
    font-size: 1rem;
  }
  a {
  color: var(--t-color-main);
  }
  h1, h2, h3, h4, h5, h6 {
    margin-bottom: var(--t-size-3);
    font-weight: bold;
    font-family: var(--t-font-family-header);
    line-height: 1em;
    margin-top: 0;
    word-break: break-word;
  }
  .atomic-button {
    background-color: var(--t-color-main);
    color: var(--t-color-bg);
    border: none;
    padding: 0.5rem 1rem;
    border-radius: var(--t-radius);
    cursor: pointer;

    &:hover:not([disabled]),
    &:focus-visible:not([disabled]) {
      background-color: var(--t-color-main-light);
      color: var(--t-color-bg);
      box-shadow: var(--t-box-shadow-soft);
    }
  }
  `;
}
