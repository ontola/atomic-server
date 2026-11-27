// @wc-ignore-file
import type { DefaultTheme } from 'styled-components';
import { uiTheme, type UITheme } from '@tomic/ui';

interface DiffColors {
  addedBg: string;
  addedFg: string;
  removedBg: string;
  removedFg: string;
}

export interface ResourceTheme extends UITheme {
  fontFamilyHeader: string;
  fontSizeH1: number;
  diffColors: DiffColors;
}
const defaults = {
  addedBg: '#e4ffe4',
  addedFg: '#003500',
  removedBg: '#ffcdcd',
  removedFg: '#2d0000',
};
const themes = new WeakMap<object, ResourceTheme>();

/** Preserve the host's Atomic theme while making the complete record UI usable in a packed consumer. */
export function resourceTheme(theme: DefaultTheme): ResourceTheme {
  let result = themes.get(theme);

  if (!result) {
    const host = theme as unknown as {
      fontFamilyHeader?: string;
      fontSizeH1?: number;
      colors?: { diff?: Partial<DiffColors> };
    };
    const shared = uiTheme(theme);
    result = {
      ...shared,
      fontFamilyHeader: host.fontFamilyHeader ?? 'system-ui, sans-serif',
      fontSizeH1: host.fontSizeH1 ?? 1.5,
      colors: {
        text1: '#444',
        warning: '#f5a623',
        ...shared.colors,
      },
      diffColors: { ...defaults, ...host.colors?.diff },
    };
    themes.set(theme, result);
  }

  return result;
}
