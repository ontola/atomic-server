// @wc-ignore-file
import type { SetupAdapter } from './types';

const adapters: SetupAdapter[] = [];

export function listAppSetups() {
  return adapters.map(({ id, declaration }) => ({ id, ...declaration }));
}
export function getAppSetup(id: string): SetupAdapter {
  const adapter = adapters.find(a => a.id === id);
  if (!adapter) throw new Error('This app has no registered setup action');

  return adapter;
}
