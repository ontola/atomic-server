// @wc-ignore-file
import { TABLE_TEMPLATES } from '../TablePage/tableTemplates';
import type { TemplateDefinition, TemplatePart } from './model';
const version = '1';
const table = (id: string, name?: string): TemplatePart => ({
  key: id,
  kind: 'template',
  template: `table/${id}`,
  version,
  name,
});

/** Table definitions remain owned by TABLE_TEMPLATES; workspaces compose them. */
export const TEMPLATE_CATALOG: TemplateDefinition[] = [
  ...TABLE_TEMPLATES.filter(t => t.spec).map(t => ({
    id: `table/${t.id}`,
    version,
    title: t.title,
    description: t.description,
    icon: '▦',
    entryPoints: ['table'] as TemplateDefinition['entryPoints'],
    parts: [
      { key: 'table', kind: 'table' as const, catalogId: t.id, name: t.title },
    ],
  })),
  {
    id: 'student',
    version,
    title: 'Student',
    icon: '🎓',
    description: 'Assignments, reading and a place for your notes.',
    entryPoints: ['workspace'],
    parts: [
      table('project-tasks', 'Assignments'),
      table('reading-list'),
      {
        key: 'notes',
        kind: 'document',
        name: 'Lecture notes',
        text: [
          'Notes for your classes. Add a page per course, or keep it all here.',
          '# Make it yours',
          '- [ ] Add your first assignment to {{project-tasks/table}}',
          '- [ ] Add a book to {{reading-list/table}}',
          '- [ ] Write down one thing you learned today',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'team',
    version,
    title: 'Team',
    icon: '🧩',
    description: 'Projects, shared knowledge and meeting notes.',
    entryPoints: ['workspace'],
    parts: [
      table('project-tasks'),
      {
        key: 'wiki',
        kind: 'document',
        name: 'Team handbook',
        text: [
          'We keep decisions in writing, so everyone can find them.',
          '# Set up',
          '- [ ] Add your first task to {{project-tasks/table}}',
          '- [ ] Write down how your team works',
          '- [ ] Take notes in {{meetings}} at your next meeting',
        ].join('\n'),
      },
      {
        key: 'meetings',
        kind: 'document',
        name: 'Meeting notes',
        text: [
          '# Agenda',
          '- [ ] What went well?',
          '- [ ] What should we focus on next?',
          '# Decisions',
          'Write down what you decided and who does what.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'personal',
    version,
    title: 'Personal',
    icon: '🌱',
    description: 'Reading, projects and everyday ideas.',
    entryPoints: ['workspace'],
    parts: [
      table('project-tasks'),
      table('reading-list'),
      table('bookmarks'),
      {
        key: 'notes',
        kind: 'document',
        name: 'Notes',
        text: [
          'Write down anything worth coming back to.',
          '# Try these',
          '- [ ] Add a task to {{project-tasks/table}}',
          '- [ ] Save a book or article in {{reading-list/table}}',
          '- [ ] Save a link in {{bookmarks/table}}',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'welcome',
    version,
    title: 'Welcome to Atomic',
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
          '# Try it',
          '- [ ] Open the {{project-tasks/table}} table and add a row.',
          '- [ ] Draw something on the {{sketch}} canvas.',
          '- [ ] Select text in {{notes}} to make it **bold**, a heading or a list.',
          'Everything is stored on this device and only you can read it. You can edit or delete anything here, including this document.',
          'The browser app can do everything; the mobile apps offer a focused subset that is still growing.',
          'Keep your work safe: save your secret or connect an account or device. The **Getting started** card on the drive page shows what is left.',
        ].join('\n'),
      },
      {
        key: 'notes',
        kind: 'document',
        name: 'Notes',
        text: 'Type something here, then select it to make it bold, a heading or a list.',
      },
      table('project-tasks', 'Tasks'),
      { key: 'sketch', kind: 'canvas', name: 'Sketch' },
    ],
  },
];
