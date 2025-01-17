import { getTsconfig } from 'get-tsconfig';

export const camelCaseify = (str: string) =>
  str.replace(/-([a-z0-9])/g, g => {
    return g[1].toUpperCase();
  });

export const dedupe = <T>(array: T[]): T[] => {
  return Array.from(new Set(array));
};

export const getExtension = () =>
  getTsconfig()?.config.compilerOptions?.moduleResolution === 'Bundler'
    ? ''
    : '.js';
