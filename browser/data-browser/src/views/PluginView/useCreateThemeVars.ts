import { useTheme } from 'styled-components';

/**
 * Returns a stylesheet that adds all our theme variables to an iframe's document as css variables.
 */
export function useCreateThemeVars() {
  const theme = useTheme();

  const themeVars: Record<string, string> = {
    '--t-container-width': `${theme.containerWidth}rem`,
    '--t-container-width-wide': theme.containerWidthWide,
    '--t-sidebar-width': `${theme.sideBarWidth}rem`,
    '--t-font-family': theme.fontFamily,
    '--t-font-family-header': theme.fontFamilyHeader,
    '--t-font-size-body': `${theme.fontSizeBody}rem`,
    '--t-font-size-h1': `${theme.fontSizeH1}rem`,
    '--t-box-shadow': theme.boxShadow,
    '--t-box-shadow-intense': theme.boxShadowIntense,
    '--t-box-shadow-soft': theme.boxShadowSoft,
    '--t-radius': theme.radius,
    '--t-height-breadcrumb-bar': theme.heights.breadCrumbBar,
    '--t-height-full-page': theme.heights.fullPage,
    '--t-height-floating-search-bar-padding':
      theme.heights.floatingSearchBarPadding,
    '--t-animation-duration': theme.animation.duration,
    // Colors
    '--t-color-main': theme.colors.main,
    '--t-color-main-light': theme.colors.mainLight,
    '--t-color-main-dark': theme.colors.mainDark,
    '--t-color-main-selected-bg': theme.colors.mainSelectedBg,
    '--t-color-main-selected-fg': theme.colors.mainSelectedFg,
    '--t-color-complementary': theme.colors.complementary,
    '--t-color-bg-body': theme.colors.bgBody,
    '--t-color-bg': theme.colors.bg,
    '--t-color-bg-1': theme.colors.bg1,
    '--t-color-bg-2': theme.colors.bg2,
    '--t-color-text': theme.colors.text,
    '--t-color-text-1': theme.colors.text1,
    '--t-color-text-light': theme.colors.textLight,
    '--t-color-text-light-2': theme.colors.textLight2,
    '--t-color-alert': theme.colors.alert,
    '--t-color-alert-light': theme.colors.alertLight,
    '--t-color-warning': theme.colors.warning,
    // Spacing / Sizes
    '--t-size-1': theme.size(1),
    '--t-size-2': theme.size(2),
    '--t-size-3': theme.size(3),
    '--t-size-4': theme.size(4),
    '--t-size-5': theme.size(5),
    '--t-size-6': theme.size(6),
    '--t-size-7': theme.size(7),
    '--t-size-8': theme.size(8),
    '--t-size-9': theme.size(9),
    '--t-size-10': theme.size(10),
    '--t-size-11': theme.size(11),
    '--t-size-12': theme.size(12),
    '--t-size-13': theme.size(13),
    '--t-size-14': theme.size(14),
    '--t-size-15': theme.size(15),
  };

  return `
  :root {
    ${Object.entries(themeVars)
      .map(([key, value]) => `${key}: ${value};`)
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
