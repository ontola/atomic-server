import type { DefaultTheme } from 'styled-components';

/** Structural theme contract; consuming apps keep their own DefaultTheme. */
export interface UITheme {
  darkMode: boolean;
  colorful: boolean;
  radius: string;
  margin: number;
  boxShadowSoft: string;
  boxShadowButton: string;
  boxShadowIntense: string;
  animation: { duration: string };
  zIndex: { dialog: number; dropdown: number };
  size: (units?: number) => string;
  colors: Record<string, string>;
}

/** The portable defaults previously used by the extracted table. */
export const defaultUITheme: UITheme = {
  darkMode: false,
  colorful: false,
  radius: '8px',
  margin: 1,
  boxShadowSoft: '0 0 0 1px #0001',
  boxShadowButton: '0 1px 3px #0002',
  boxShadowIntense: '0 4px 16px #0003',
  animation: { duration: '0.1s' },
  zIndex: { dialog: 100, dropdown: 200 },
  size: (units = 1) => `${units * 0.25}rem`,
  colors: {
    main: '#1849d6',
    mainLight: '#e7edff',
    mainDark: '#1239aa',
    mainSelectedBg: '#e7edff',
    mainSelectedFg: '#1239aa',
    alert: '#b42318',
    alertLight: '#fee4e2',
    text: '#333',
    textLight: '#5e5e5e',
    textLight2: '#777',
    bg: '#fff',
    bgBody: '#fbfbfb',
    bg1: '#f3f3f3',
    bg2: '#dfdfdf',
  },
};
const themes = new WeakMap<object, UITheme>();

/** Hosts supply their existing theme through styled-components' ThemeProvider. */
export function uiTheme(theme: DefaultTheme): UITheme {
  let result = themes.get(theme);

  if (!result) {
    const host = theme as unknown as Partial<UITheme>;
    result = {
      ...defaultUITheme,
      ...host,
      colors: { ...defaultUITheme.colors, ...host.colors },
      animation: { ...defaultUITheme.animation, ...host.animation },
      zIndex: { ...defaultUITheme.zIndex, ...host.zIndex },
    };
    themes.set(theme, result);
  }

  return result;
}
