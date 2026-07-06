import { TableSpec } from './createTableFromSpec';

export interface TableTemplate {
  id: string;
  title: string;
  description: string;
  /** What a single row of this table is called — becomes the row class's name. */
  rowName: string;
  /** The table to build. Absent for the `blank` starting point. */
  spec?: Omit<TableSpec, 'name' | 'rowName'>;
}

/** Starting points offered in the New Table dialog. `blank` is the default. */
export const TABLE_TEMPLATES: TableTemplate[] = [
  {
    id: 'blank',
    title: 'Blank',
    description: 'An empty table you configure yourself.',
    rowName: 'Row',
  },
  {
    id: 'issue-tracker',
    title: 'Issue Tracker',
    description:
      'Issues with Status, Assignee and Priority — plus a ready-made kanban board.',
    rowName: 'Issue',
    spec: {
      columns: [
        {
          name: 'Status',
          type: 'select',
          options: ['Todo', 'Doing', 'Done'],
        },
        { name: 'Assignee', type: 'text' },
        {
          name: 'Priority',
          type: 'select',
          options: ['Low', 'Medium', 'High'],
        },
      ],
      views: [
        {
          name: 'Board',
          kind: 'kanban',
          groupByColumn: 'Status',
          default: true,
        },
        { name: 'All issues', kind: 'table' },
      ],
    },
  },
];
