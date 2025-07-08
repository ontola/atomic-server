import { getTsconfig } from 'get-tsconfig';

export const camelCaseify = (str: string) =>
  str.replace(/-([a-z0-9])/g, g => {
    return g[1].toUpperCase();
  });

export const dedupe = <T>(array: T[]): T[] => {
  return Array.from(new Set(array));
};

export const getExtension = () => {
  try {
    const tsconfig = getTsconfig();
    if (!tsconfig) return '.js';
    const moduleResolution = tsconfig.config.compilerOptions?.moduleResolution;
    if (!moduleResolution) return '.js';
    return moduleResolution === 'Bundler' ? '' : '.js';
  } catch (error) {
    console.error('Error getting extension:', error);
    return '.js';
  }
};
