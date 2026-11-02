import type { DefaultTheme } from 'styled-components';

/** The table accepts the host theme without augmenting its global DefaultTheme. */
export interface TableTheme {
  darkMode: boolean;
  radius: string;
  margin: number;
  containerWidthWide: string;
  boxShadowSoft: string;
  boxShadowButton: string;
  boxShadowIntense: string;
  animation: { duration: string };
  size: (units?: number) => string;
  colors: Record<string, string>;
}
export const defaultTableTheme: TableTheme = {
  darkMode: false,
  radius: '8px',
  margin: 1,
  containerWidthWide: '70rem',
  boxShadowSoft: '0 0 0 1px #0001',
  boxShadowButton: '0 1px 3px #0002',
  boxShadowIntense: '0 4px 16px #0003',
  animation: { duration: '0.1s' },
  size: (units = 1) => `${units * 0.25}rem`,
  colors: {
    main: '#1849d6',
    mainLight: '#e7edff',
    mainDark: '#1239aa',
    alert: '#b42318',
    alertLight: '#fee4e2',
    text: '#333',
    textLight: '#5e5e5e',
    bg: '#fff',
    bgBody: '#fbfbfb',
    bg1: '#f3f3f3',
    bg2: '#dfdfdf',
  },
};
const themes = new WeakMap<object, TableTheme>();

export function tableTheme(theme: DefaultTheme): TableTheme {
  let result = themes.get(theme);

  if (!result) {
    const host = theme as unknown as Partial<TableTheme>;
    result = {
      ...defaultTableTheme,
      ...host,
      colors: { ...defaultTableTheme.colors, ...host.colors },
      animation: { ...defaultTableTheme.animation, ...host.animation },
    };
    themes.set(theme, result);
  }

  return result;
}
