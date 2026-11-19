import type { DefaultTheme } from 'styled-components';
import { defaultUITheme, uiTheme, type UITheme } from '@tomic/ui';

/** Retain the existing table theme API without an application theme dependency. */
export interface TableTheme extends Omit<UITheme, 'colorful' | 'zIndex'> {
  containerWidthWide: string;
}
export const defaultTableTheme: TableTheme = {
  ...defaultUITheme,
  containerWidthWide: '70rem',
};
const themes = new WeakMap<object, TableTheme>();

export function tableTheme(theme: DefaultTheme): TableTheme {
  let result = themes.get(theme);

  if (!result) {
    result = {
      ...uiTheme(theme),
      containerWidthWide:
        (theme as unknown as Partial<TableTheme>).containerWidthWide ?? '70rem',
    };
    themes.set(theme, result);
  }

  return result;
}
