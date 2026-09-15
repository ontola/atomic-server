const calls = [];

export function resetCalls() {
  calls.length = 0;
}

export function recordedCalls() {
  return [...calls];
}

export function makeChain(label = 'chain') {
  return new Proxy(
    { label },
    {
      get(target, property) {
        if (property === 'then') return undefined;
        if (property === 'stdout') return async () => '';
        if (property === 'contents') return async () => '';
        if (property === 'directory' || property === 'file')
          return (...args) => {
            calls.push([String(property), ...args]);
            return makeChain(`${target.label}.${String(property)}`);
          };
        return (...args) => {
          calls.push([String(property), ...args]);
          return makeChain(`${target.label}.${String(property)}`);
        };
      },
    },
  );
}

export const dag = {
  container: () => makeChain('container'),
  cacheVolume: name => ({ name }),
};

export class Container {}
export class Directory {}
export class Secret {}
export class File {}
export class Platform {}
export class Service {}
export const CacheSharingMode = {};
export const object = () => value => value;
export const func = () => value => value;
export const argument = () => value => value;
