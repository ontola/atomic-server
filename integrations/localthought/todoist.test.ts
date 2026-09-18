import { expect, it } from 'vitest';
import { Datatype } from '../../browser/lib/src/index';
import { platformSchema, type FetchedPlatform } from './schema';
import { todoistFields as fields, todoistProjection } from './todoist';

const term = (
  shortname: string,
  kind: 'class' | 'property',
  datatype = Datatype.STRING,
  recommends: string[] = [],
) => ({
  path: shortname,
  kind,
  shortname,
  description: '',
  datatype,
  requires: [],
  recommends,
});

const fixture = (): FetchedPlatform => ({
  platform: 'todoist',
  ontology: {
    description: '',
    terms: [
      term('task', 'class', Datatype.STRING, ['content', 'checked', 'due', 'priority']),
      term('project', 'class', Datatype.STRING, ['name']),
      term('content', 'property'),
      term('checked', 'property', Datatype.BOOLEAN),
      term('due', 'property', Datatype.JSON),
      term('priority', 'property', Datatype.INTEGER),
      term('name', 'property'),
    ],
  },
  records: [
    {
      resource: 'task',
      namespace: 'todoist',
      id: '100',
      name: '100',
      values: {
        content: 'Buy milk',
        checked: false,
        due: { date: '2026-09-20', is_recurring: false, string: 'Sep 20' },
        priority: 4,
      },
    },
    {
      resource: 'task',
      namespace: 'todoist',
      id: '101',
      name: '101',
      values: {
        content: 'Call the dentist',
        checked: true,
        due: { datetime: '2026-09-18T09:00:00Z' },
        priority: 1,
      },
    },
    {
      resource: 'task',
      namespace: 'todoist',
      id: '102',
      name: '102',
      values: { content: '   ' },
    },
    {
      resource: 'project',
      namespace: 'todoist',
      id: '7',
      name: 'Inbox',
      values: { name: 'Inbox' },
    },
  ],
});

it('names tasks after their content and adds done, due day and priority', () => {
  const projected = todoistProjection(fixture());
  const [milk, dentist, blank, project] = projected.records;

  expect(milk.name).toBe('Buy milk');
  expect(milk.values[fields.done]).toBe(false);
  expect(milk.values[fields.dueDay]).toBe('2026-09-20');
  expect(milk.values[fields.priorityLabel]).toBe('Urgent');
  // Provider fields stay on the row.
  expect(milk.values.content).toBe('Buy milk');

  expect(dentist.name).toBe('Call the dentist');
  expect(dentist.values[fields.done]).toBe(true);
  expect(dentist.values[fields.dueDay]).toBe('2026-09-18');
  expect(dentist.values[fields.priorityLabel]).toBe('Normal');

  // Blank content keeps the id as a name rather than an empty title.
  expect(blank.name).toBe('102');
  expect(blank.values[fields.done]).toBe(false);
  expect(blank.values).not.toHaveProperty(fields.dueDay);

  expect(project).toEqual(fixture().records[3]);
});

it('adds the projected properties to the task class and the shared schema', () => {
  const projected = todoistProjection(fixture());
  const task = projected.ontology.terms.find(t => t.shortname === 'task')!;

  for (const shortname of Object.values(fields)) {
    const extra = projected.ontology.terms.find(
      t => t.shortname === shortname,
    );
    expect(extra?.kind).toBe('property');
    expect(task.recommends).toContain(extra!.path);
  }

  const schema = platformSchema('todoist', projected.ontology.terms);
  const done = schema.properties.find(p =>
    p.shortname.endsWith(`-${fields.done}`),
  );
  expect(done?.datatype).toBe(Datatype.BOOLEAN);
  const dueDay = schema.properties.find(p =>
    p.shortname.endsWith(`-${fields.dueDay}`),
  );
  expect(dueDay?.datatype).toBe(Datatype.DATE);
});

it('leaves other platforms and platforms without a task class alone', () => {
  const other = { ...fixture(), platform: 'clockify' };
  expect(todoistProjection(other)).toBe(other);

  const noTask = fixture();
  noTask.ontology.terms = noTask.ontology.terms.filter(
    t => t.shortname !== 'task',
  );
  expect(todoistProjection(noTask)).toBe(noTask);
});

it('refuses a provider ontology that already claims a projected shortname', () => {
  const clash = fixture();
  clash.ontology.terms.push(term(fields.done, 'property', Datatype.BOOLEAN));
  expect(() => todoistProjection(clash)).toThrow(/collides/);
});
