import type { TemplateDefinition } from './model';

/** Parts the Welcome template plans: the document, the Tasks table, the Sketch canvas. */
export const WELCOME_PART_COUNT = 3;

const TASKS_LINK = '{{project-tasks/table}}';
const SKETCH_LINK = '{{sketch}}';

/** The Welcome drive's title, in the language the app is in right now. */
export function welcomeDriveTitle(): string {
  return 'Welcome to Atomic';
}

/**
 * The drive a new person starts in. A function, not a constant, so its words
 * are translated when the drive is made: nothing else reads them by name.
 */
export function welcomeTemplate(): TemplateDefinition {
  return {
    id: 'welcome',
    version: '1',
    title: welcomeDriveTitle(),
    icon: '👋',
    description: 'The drive a new person starts in.',
    // Not offered as a starter: `startWelcomeDrive` builds it.
    entryPoints: [],
    parts: [
      {
        key: 'welcome',
        kind: 'document',
        name: 'Start here',
        text: [
          'Welcome to Atomic. This is a small drive to play in, at your own pace. There is nothing you have to do.',
          `In it you will find a ${TASKS_LINK} table to keep track of things and a ${SKETCH_LINK} canvas to draw on.`,
          'Select text in this document to make it **bold**, a heading or a list.',
          'Everything is stored on this device and only you can read it. You can edit or delete anything here, including this document.',
          'The **Getting started** panel in the sidebar shows the next steps.',
        ].join('\n'),
      },
      {
        key: 'project-tasks',
        kind: 'template',
        template: 'table/project-tasks',
        version: '1',
        name: 'Tasks',
      },
      { key: 'sketch', kind: 'canvas', name: 'Sketch' },
    ],
  };
}
