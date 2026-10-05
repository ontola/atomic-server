import {
  checkGate,
  requiresGate,
  type HostFeatureUnavailable,
  type PluginRoutesStatus,
} from '@tomic/react';

/**
 * A server from before the plugin-routes gates (#1711) reports no
 * `hostFeatures`; it can't open public endpoints at all.
 */
export const NO_PLUGIN_ROUTES: PluginRoutesStatus = {
  compiled: false,
  level: 'off',
  routesOrigin: null,
  listeners: [],
  sidecars: [],
};

export interface GatedEntry<T> {
  entry: T;
  /**
   * Set when this node's gates don't allow the entry's public endpoints yet
   * (compiled, level too low or a listener or sidecar missing). The entry is
   * shown, marked, and can't be installed.
   */
  refusal?: HostFeatureUnavailable;
}

/**
 * Splits catalog entries by what this node can host (design 0.5):
 * gated entries are hidden when the build has no plugin routes, and marked
 * when the operator hasn't raised the level far enough. Only the entries'
 * derived `requires` is read, so nothing is fetched.
 */
export function gateCatalog<T extends { requires?: string[] | null }>(
  entries: T[],
  pluginRoutes: PluginRoutesStatus | undefined,
): { shown: GatedEntry<T>[]; hidden: number } {
  const node = pluginRoutes ?? NO_PLUGIN_ROUTES;
  const shown: GatedEntry<T>[] = [];
  let hidden = 0;

  for (const entry of entries) {
    const refusal = checkGate(requiresGate(entry.requires), node);

    if (refusal && !refusal.compiled) hidden++;
    else shown.push(refusal ? { entry, refusal } : { entry });
  }

  return { shown, hidden };
}
