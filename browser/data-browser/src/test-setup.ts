// Node 25+ ships Web Storage on `globalThis` (`--experimental-webstorage` is on
// by default), and without `--localstorage-file` its `localStorage` is
// undefined. Vitest's jsdom environment only copies window keys the global
// does not already have, so jsdom's working Storage never reaches `window`
// and every `// @vitest-environment jsdom` test that touches storage throws.
// Put jsdom's back. A no-op under Node 22/24 and in the node environment.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;

if (dom) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    if (!globalThis[key]) {
      Object.defineProperty(globalThis, key, {
        value: dom.window[key],
        configurable: true,
        writable: true,
      });
    }
  }
}
