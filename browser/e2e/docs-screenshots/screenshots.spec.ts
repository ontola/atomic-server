import { test } from '@playwright/test';
import { installEmptyDiscoveryRoom } from '../tests/fixtures';
import { installCommitWatcher } from '../tests/test-utils';
import { acmeDrive, seedAISettings } from './setup';
import * as scenes from './scenes';

/**
 * Screenshots for the atomic.place docs: `pnpm docs:screenshots`, with the
 * server on :9883 and the app on :6747 running (see README.md). Every scene
 * starts from a fresh agent and drive, so none depends on another.
 */
const SCENES = {
  'ai-chat': scenes.aiChat,
  chat: scenes.groupChat,
  overview: scenes.overview,
  drives: scenes.drives,
  documents: scenes.documents,
  sharing: scenes.sharing,
  tables: scenes.tables,
  kanban: scenes.kanban,
  meetings: scenes.meetings,
  canvas: scenes.canvas,
  apps: scenes.apps,
  forms: scenes.forms,
  'forms-fill': scenes.formsFill,
};

for (const [name, scene] of Object.entries(SCENES))
  test(name, async ({ page, browser }) => {
    await installEmptyDiscoveryRoom(page.context());
    await seedAISettings(page);
    await installCommitWatcher(page);
    const drive = await acmeDrive(page);
    await scene(page, browser, drive);
  });
