// @wc-ignore-file
import { parseSetupDeclaration } from '../../../../../browser/lib/src/plugin-setup';
import { requireInstallationServer } from '../../../../../browser/lib/src/plugin-installation';
import type { SetupAdapter } from './types';
import {
  setup as notionSetup,
  setupDeclaration as notionDeclaration,
} from '../../../../../integrations/notion/setup';

const notion: SetupAdapter = {
  id: 'notion',
  icon: '📓',
  declaration: parseSetupDeclaration(notionDeclaration),
  preflight: ({ store, drive }) => requireInstallationServer(store, drive),
  choices: async () => {
    throw new Error('Unknown setup lookup');
  },
  prepare: notionSetup,
  credential: {
    label: 'Notion connection token',
    description:
      'Stored on your AtomicServer, outside setup arguments. Compatibility notes appear before you approve any sync.',
  },
  connect: async (raw, token, { store, drive }) => {
    const args = notionSetup(raw);
    const { installNotion } =
      await import('../../chunks/PluginRuns/notionInstaller');
    const result = await installNotion(store, drive, args.dataSource, token);

    return { subject: result.table };
  },
};
const adapters = [notion];

export function listAppSetups() {
  return adapters.map(({ id, declaration }) => ({ id, ...declaration }));
}
export function getAppSetup(id: string): SetupAdapter {
  const adapter = adapters.find(a => a.id === id);
  if (!adapter) throw new Error('This app has no registered setup action');

  return adapter;
}
