import { sys as tsSys, findConfigFile, readConfigFile } from 'typescript';

const NOT_FOUND = 'tsconfig.json not found';
const COULD_NOT_READ = 'Could not read tsconfig.json';

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
    const moduleResolution = tsconfig.config.compilerOptions?.moduleResolution;

    if (!moduleResolution) {
      return '.js';
    }

    return moduleResolution.toLowerCase() === 'bundler' ? '' : '.js';
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === NOT_FOUND) {
        // eslint-disable-next-line no-console
        console.log('tsconfig.json not found, defaulting to .js imports');

        return '.js';
      }

      if (error.message === COULD_NOT_READ) {
        // eslint-disable-next-line no-console
        console.log('Could not read tsconfig.json, defaulting to .js imports');

        return '.js';
      }

      throw error;
    } else {
      throw new Error(String(error));
    }
  }
};

const getTsconfig = () => {
  // Find tsconfig.json file
  const tsconfigPath = findConfigFile(
    process.cwd(),
    tsSys.fileExists,
    'tsconfig.json',
  );

  if (!tsconfigPath) throw new Error(NOT_FOUND);

  // Read tsconfig.json file
  const tsconfigFile = readConfigFile(tsconfigPath, tsSys.readFile);

  if (!tsconfigFile.config) throw new Error(COULD_NOT_READ);

  return tsconfigFile;
};
