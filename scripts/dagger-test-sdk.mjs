const calls = [];
let response;

/** Supply individual SDK responses without replacing the module under test. */
export function setChainResponse(resolver) {
  response = resolver;
}

export function resetCalls() {
  calls.length = 0;
  response = undefined;
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
        if (['stdout', 'contents', 'platform'].includes(property))
          return async (...args) => {
            const supplied = response?.(target.label, property, args);
            if (supplied !== undefined) return supplied;

            return property === 'platform' ? 'linux/amd64' : '';
          };
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
  directory: () => makeChain('directory'),
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
