import { useEffect, useState } from 'react';
type KatexPlugin = typeof import('rehype-katex').default;

let katexPromise: Promise<KatexPlugin> | undefined;
let katexPlugin: KatexPlugin | undefined;

/** Math is rare, KaTeX (plus its CSS) is ~240 kB, so fetch it on first use. */
function loadKatex(): Promise<KatexPlugin> {
  katexPromise ??= Promise.all([
    import('rehype-katex'),
    import('katex/dist/katex.min.css'),
  ]).then(([mod]) => {
    katexPlugin = mod.default;

    return katexPlugin;
  });

  return katexPromise;
}

/**
 * The rehype plugin that renders math, once loaded. Only text that can contain
 * math (a `$`) triggers the download; until it arrives the formula shows as
 * plain code.
 */
export function useRehypeKatex(
  text: string | undefined,
): KatexPlugin | undefined {
  const needsMath = !!text && text.includes('$');
  const [plugin, setPlugin] = useState<KatexPlugin | undefined>(katexPlugin);

  useEffect(() => {
    if (!needsMath || plugin) return;

    let cancelled = false;

    loadKatex()
      .then(p => {
        if (!cancelled) setPlugin(() => p);
      })
      .catch(() => {
        // Keep showing the formula as code when the chunk cannot load.
      });

    return () => {
      cancelled = true;
    };
  }, [needsMath, plugin]);

  return plugin;
}
