import { ai, canvas, core, dataBrowser } from '@tomic/lib';
import { TABLE_TEMPLATES } from '../../chunks/TablePage/tableTemplates';
import { templates } from '../../components/Template/template';

export const BASIC_CREATIONS = [
  {
    subject: dataBrowser.classes.table,
    title: 'Table',
    description: 'Organize data in rows, boards and other views.',
  },
  {
    subject: dataBrowser.classes.documentV2,
    title: 'Document',
    description: 'Write notes, plans or something worth sharing.',
  },
  {
    subject: dataBrowser.classes.folder,
    title: 'Folder',
    description: 'Keep related work together.',
  },
  {
    subject: dataBrowser.classes.dashboard,
    title: 'Dashboard',
    description: 'Bring tables, charts and resources together.',
  },
  {
    subject: dataBrowser.classes.meeting,
    title: 'Meeting',
    description: 'Capture a conversation and its notes.',
  },
  {
    subject: dataBrowser.classes.chatroom,
    title: 'Chat room',
    description: 'Start a conversation with your team.',
  },
  {
    subject: dataBrowser.classes.bookmark,
    title: 'Bookmark',
    description: 'Save a link for later.',
  },
  {
    subject: canvas.classes.canvas,
    title: 'Canvas',
    description: 'Arrange ideas on a shared canvas.',
  },
  {
    subject: core.classes.ontology,
    title: 'Ontology',
    description: 'Define reusable resource types and properties.',
  },
  {
    subject: ai.classes.aiChat,
    title: 'AI chat',
    description: 'Start a dedicated conversation with an assistant.',
  },
];
export function matchesCreationSearch(
  query: string,
  ...values: string[]
): boolean {
  const haystack = values.join(' ').toLocaleLowerCase();

  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every(word => haystack.includes(word));
}
export const CREATION_TABLE_TEMPLATES = TABLE_TEMPLATES.filter(t => t.spec);
export const CREATION_PAGE_TEMPLATES = templates;

/**
 * What the assistant can build that this page otherwise never mentions.
 *
 * Apps and websites are minted per drive, so their classes only show up under
 * "Your resource types" once the drive already has one — which is to say,
 * never, for anyone who has not already been told they exist. Dashboards and
 * tables do have a blank button, but a blank one is not the part worth
 * discovering: the assistant fills them from data already on the drive.
 *
 * Every seed is deliberately unfinished. A suggestion puts its seed in the
 * composer with the caret at the end instead of sending it, because "build me
 * an app" on its own tells the assistant nothing and it would only have to ask
 * the same question back.
 */
export const AI_BUILD_SUGGESTIONS: AIBuildSuggestion[] = [
  {
    id: 'app',
    title: 'An app',
    seed: 'Build an app that ',
  },
  {
    id: 'website',
    title: 'A website',
    seed: 'Build a website for ',
  },
  {
    id: 'dashboard',
    title: 'A dashboard',
    seed: 'Build a dashboard showing ',
  },
  {
    id: 'table',
    title: 'A custom table',
    seed: 'Build a table for tracking ',
  },
];

export interface AIBuildSuggestion {
  id: string;
  title: string;
  seed: string;
}

/**
 * Whether the composer still holds nothing but a suggestion.
 *
 * Suggestions replace what is in the composer, so they are only offered while
 * there is nothing of the user's own to lose. Setting a textarea's value from
 * code does not go on the browser's undo stack, so a click that wiped a
 * half-written description could not be taken back.
 */
export function isUntouchedSuggestion(prompt: string): boolean {
  return (
    prompt === '' || AI_BUILD_SUGGESTIONS.some(item => item.seed === prompt)
  );
}
