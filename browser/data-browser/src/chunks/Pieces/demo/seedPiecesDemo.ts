// @wc-ignore-file
import {
  core,
  createApp,
  dataBrowser,
  Datatype,
  ensureSchema,
  type JSONValue,
  type SchemaSpec,
  type Store,
} from '@tomic/lib';
import { handOverAppKey } from '@chunks/AppPage/appAgent';
import { piecesSchema } from '../piecesSchema';
import { getAlongPath, type LensMapping } from '../lens';
import { timesheetSource } from './timesheetSource';
import { integrationSource } from './integrationSource';

/**
 * Row classes for the demo, minted in the drive so it runs offline.
 *
 * - `time-entry` stands in for atomic-plugins' shared
 *   `ontology/classes/time-entry-v1`, which the Timesheet view is bound to.
 * - `clockify-time-entry` stands in for what syncables would produce from
 *   Clockify's OpenAPI document (`description`, `timeInterval.start/end` as
 *   ISO strings, `billable`): the integration's native row class.
 * - `grocery-item` matches nothing, to show what is not offered.
 */
function demoSchema(): SchemaSpec {
  return {
    properties: [
      {
        subject: core.properties.name,
        shortname: 'name',
        name: 'Name',
        description: 'Name',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'entry-start',
        name: 'Start',
        description: 'When the work started.',
        datatype: Datatype.TIMESTAMP,
      },
      {
        shortname: 'entry-end',
        name: 'End',
        description: 'When the work ended. Empty while the timer runs.',
        datatype: Datatype.TIMESTAMP,
      },
      {
        shortname: 'entry-billable',
        name: 'Billable',
        description: 'Whether the time can be invoiced.',
        datatype: Datatype.BOOLEAN,
      },
      {
        shortname: 'clockify-description',
        name: 'Description',
        description: 'Clockify TimeEntry.description',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'clockify-start',
        name: 'Interval start',
        description: 'Clockify TimeEntry.timeInterval.start (ISO 8601)',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'clockify-end',
        name: 'Interval end',
        description: 'Clockify TimeEntry.timeInterval.end (ISO 8601)',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'clockify-billable',
        name: 'Billable',
        description: 'Clockify TimeEntry.billable',
        datatype: Datatype.BOOLEAN,
      },
      {
        shortname: 'toggl-description',
        name: 'Description',
        description: 'Toggl Track TimeEntry.description',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'toggl-start',
        name: 'Start',
        description: 'Toggl Track TimeEntry.start (ISO 8601)',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'toggl-stop',
        name: 'Stop',
        description: 'Toggl Track TimeEntry.stop (ISO 8601)',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'toggl-billable',
        name: 'Billable',
        description: 'Toggl Track TimeEntry.billable',
        datatype: Datatype.BOOLEAN,
      },
      {
        shortname: 'grocery-quantity',
        name: 'Quantity',
        description: 'How many to buy.',
        datatype: Datatype.INTEGER,
      },
    ],
    classes: [
      {
        shortname: 'time-entry',
        name: 'Time entry',
        description:
          'A stretch of work. Stand-in for atomic-plugins ontology time-entry-v1.',
        requires: ['name', 'entry-start'],
        recommends: ['entry-end', 'entry-billable'],
      },
      {
        shortname: 'clockify-time-entry',
        name: 'Clockify time entry',
        description:
          'A Clockify TimeEntry as syncables would produce it from the Clockify OpenAPI document.',
        requires: ['clockify-description', 'clockify-start'],
        recommends: ['clockify-end', 'clockify-billable'],
      },
      {
        shortname: 'toggl-time-entry',
        name: 'Toggl time entry',
        description:
          'A Toggl Track TimeEntry as syncables would produce it from the Toggl OpenAPI document.',
        requires: ['toggl-description', 'toggl-start'],
        recommends: ['toggl-stop', 'toggl-billable'],
      },
      {
        shortname: 'grocery-item',
        name: 'Grocery item',
        description: 'Something to buy.',
        requires: ['name'],
        recommends: ['grocery-quantity'],
      },
    ],
  };
}

export interface SeededDemo {
  hours: string;
  groceries: string;
  clockifyMirror: string;
  timesheet: string;
  clockify: string;
  lens: string;
  toggl: string;
  togglLens: string;
}

const at = (day: number, hour: number, minute = 0) =>
  Date.UTC(2026, 9, 5 + day, hour, minute);

async function create(
  store: Store,
  parent: string,
  isA: string,
  propVals: Record<string, JSONValue>,
): Promise<string> {
  const resource = await store.newResource({ parent, isA: [isA], propVals });
  await resource.save();

  return resource.subject;
}

async function setProps(
  store: Store,
  subject: string,
  propVals: Record<string, JSONValue>,
) {
  const resource = await store.getResource(subject);

  for (const [p, v] of Object.entries(propVals)) await resource.set(p, v);

  await resource.save();
}

/**
 * Seeds one table view, one integration and one lens into `drive`, plus three
 * tables to try them on. Not idempotent: run it on a fresh dev drive.
 */
export async function seedPiecesDemo(
  store: Store,
  drive: string,
): Promise<SeededDemo> {
  const pieces = await ensureSchema(store, drive, piecesSchema());
  const demo = await ensureSchema(store, drive, demoSchema());
  const p = demo.properties;
  const c = demo.classes;

  // The lens: Time entry ↔ Clockify time entry. Declarative, so it is data.
  const mapping: LensMapping = {
    version: 1,
    fields: [
      { source: core.properties.name, target: p['clockify-description'] },
      {
        source: p['entry-start'],
        target: p['clockify-start'],
        convert: 'ms-to-iso',
      },
      {
        source: p['entry-end'],
        target: p['clockify-end'],
        convert: 'ms-to-iso',
      },
      { source: p['entry-billable'], target: p['clockify-billable'] },
    ],
  };
  const lens = await create(store, drive, pieces.classes.lens, {
    [core.properties.name]: 'Time entry ↔ Clockify time entry',
    [core.properties.description]:
      'Lets Clockify sync tables of time entries, and anything written for time entries read Clockify mirrors.',
    [pieces.properties['lens-source']]: c['time-entry'],
    [pieces.properties['lens-target']]: c['clockify-time-entry'],
    [pieces.properties['lens-mapping']]: mapping as unknown as JSONValue,
    // Already reviewed, so Clockify is offered on Hours from the start.
    [pieces.properties['lens-review']]: 'approved',
  });

  // A second, drive-local lens nobody has reviewed yet (Q-089). Toggl shows on
  // Hours as waiting for review until it is approved on the demo page.
  const togglLens = await create(store, drive, pieces.classes.lens, {
    [core.properties.name]: 'Time entry ↔ Toggl time entry',
    [core.properties.description]:
      'Lets Toggl Track sync tables of time entries. Drive-local: needs review.',
    [pieces.properties['lens-source']]: c['time-entry'],
    [pieces.properties['lens-target']]: c['toggl-time-entry'],
    [pieces.properties['lens-mapping']]: {
      version: 1,
      fields: [
        { source: core.properties.name, target: p['toggl-description'] },
        {
          source: p['entry-start'],
          target: p['toggl-start'],
          convert: 'ms-to-iso',
        },
        {
          source: p['entry-end'],
          target: p['toggl-stop'],
          convert: 'ms-to-iso',
        },
        { source: p['entry-billable'], target: p['toggl-billable'] },
      ],
    } as unknown as JSONValue,
    [pieces.properties['lens-review']]: 'pending',
  });

  // Table X: time entries. Offers Timesheet natively, Clockify through the lens.
  const hours = await create(store, drive, dataBrowser.classes.table, {
    [core.properties.name]: 'Hours',
    [core.properties.classtype]: c['time-entry'],
  });

  const entries: [string, number, number | undefined, boolean][] = [
    ['Client call: Acme', at(0, 9), at(0, 10, 30), true],
    ['Write Q3 report', at(0, 11), at(0, 13), true],
    ['Code review', at(1, 14), at(1, 15, 15), false],
    ['Planning: roadmap', at(1, 9, 30), at(1, 10), true],
    ['Timer still running', at(2, 8), undefined, true],
    ['Lunch talk', at(2, 12), at(2, 13), false],
  ];
  const rows: { subject: string; props: Record<string, JSONValue> }[] = [];

  for (const [name, start, end, billable] of entries) {
    const props: Record<string, JSONValue> = {
      [core.properties.name]: name,
      [p['entry-start']]: start,
      [p['entry-billable']]: billable,
      ...(end ? { [p['entry-end']]: end } : {}),
    };
    rows.push({
      subject: await create(store, hours, c['time-entry'], props),
      props,
    });
  }

  // Table Z: unrelated. Offers neither piece.
  const groceries = await create(store, drive, dataBrowser.classes.table, {
    [core.properties.name]: 'Groceries',
    [core.properties.classtype]: c['grocery-item'],
  });

  for (const [name, quantity] of [
    ['Oat milk', 2],
    ['Coffee beans', 1],
    ['Apples', 6],
  ] as const) {
    await create(store, groceries, c['grocery-item'], {
      [core.properties.name]: name,
      [p['grocery-quantity']]: quantity,
    });
  }

  // The view: a drive App bound to Time entry.
  const timesheet = await createApp(store, {
    drive,
    name: 'Timesheet',
    emoji: '🗓️',
    description: 'A table view for time entries. Strictly a view: no sync.',
    rowClass: c['time-entry'],
    rowName: { singular: 'Time entry', plural: 'Timesheet entries' },
    source: timesheetSource({
      name: core.properties.name,
      start: p['entry-start'],
      end: p['entry-end'],
      billable: p['entry-billable'],
    }),
  });
  await setProps(store, timesheet.app, {
    [pieces.properties['piece-kind']]: 'view',
  });
  await handOver(store, drive, timesheet);

  // The integration: a drive App bound to Clockify time entry. Its own table
  // (the app's data) is a Clockify-shaped mirror, table Y.
  const clockify = await createApp(store, {
    drive,
    name: 'Clockify',
    emoji: '⏱️',
    description:
      'Syncs a table with Clockify and shows its sync state. Demo: the platform is a fixture.',
    rowClass: c['clockify-time-entry'],
    rowName: {
      singular: 'Clockify time entry',
      plural: 'Clockify mirror',
    },
    source: integrationSource({
      provider: 'Clockify',
      account: 'Demo workspace (fixture, no network)',
      description: p['clockify-description'],
      start: p['clockify-start'],
      end: p['clockify-end'],
      billable: p['clockify-billable'],
      bindingClass: pieces.classes['sync-binding'],
      syncedTable: pieces.properties['synced-table'],
      syncState: pieces.properties['sync-state'],
      name: core.properties.name,
    }),
  });
  await setProps(store, clockify.app, {
    [pieces.properties['piece-kind']]: 'integration',
    [pieces.properties['piece-provider']]: 'clockify',
  });
  await handOver(store, drive, clockify);

  await create(store, clockify.data, c['clockify-time-entry'], {
    [p['clockify-description']]: 'Imported from Clockify',
    [p['clockify-start']]: '2026-10-02T13:00:00.000Z',
    [p['clockify-end']]: '2026-10-02T14:30:00.000Z',
    [p['clockify-billable']]: true,
  });

  // Install state on Hours: a binding with a realistic outbox, so every state
  // shows on first open. The integration creates an empty one itself on any
  // other table it is added to.
  const path = [{ mapping, direction: 'forward' as const }];
  const payload = (i: number) => getAlongPath(path, rows[i].props);
  const desc = p['clockify-description'];
  const ago = Date.now() - 2 * 3600_000;

  const syncState = {
    account: { id: 'ws-demo', label: 'Demo workspace (fixture, no network)' },
    lastSync: ago,
    installedThrough: [lens],
    remote: {
      [rows[0].subject]: { id: 'ce_a1', payload: payload(0) },
      [rows[1].subject]: {
        id: 'ce_a2',
        payload: { ...payload(1), [desc]: 'Write report' },
      },
      [rows[3].subject]: {
        id: 'ce_a4',
        payload: { ...payload(3), [desc]: 'Sprint planning' },
      },
      [rows[5].subject]: { id: 'ce_a6', payload: payload(5) },
    },
    writes: [
      {
        row: rows[1].subject,
        title: 'Write Q3 report',
        type: 'update',
        remoteId: 'ce_a2',
        state: 'pending',
        payload: payload(1),
        attempts: 0,
      },
      {
        row: rows[2].subject,
        title: 'Code review',
        type: 'create',
        state: 'held',
        payload: payload(2),
        attempts: 0,
      },
      {
        row: rows[3].subject,
        title: 'Planning: roadmap',
        type: 'update',
        remoteId: 'ce_a4',
        state: 'pending',
        payload: payload(3),
        attempts: 1,
        conflicts: [
          {
            field: desc,
            base: 'Planning',
            remote: 'Sprint planning',
            local: 'Planning: roadmap',
          },
        ],
      },
      {
        row: rows[4].subject,
        title: 'Timer still running',
        type: 'create',
        state: 'failed',
        payload: payload(4),
        attempts: 3,
        lastStatus: 400,
        lastError:
          'Clockify refuses an entry without an end time. Stop the timer, then retry.',
      },
    ],
    discarded: {},
  };

  await create(store, clockify.app, pieces.classes['sync-binding'], {
    [core.properties.name]: 'Clockify sync: Hours',
    [pieces.properties['synced-table']]: hours,
    [pieces.properties['sync-state']]: syncState as unknown as JSONValue,
  });

  // A second integration (Q-090): several can sync one table, each with its
  // own binding. Offered on Hours once its lens is approved.
  const toggl = await createApp(store, {
    drive,
    name: 'Toggl Track',
    emoji: '🟣',
    description:
      'Syncs a table with Toggl Track and shows its sync state. Demo: the platform is a fixture.',
    rowClass: c['toggl-time-entry'],
    rowName: { singular: 'Toggl time entry', plural: 'Toggl mirror' },
    source: integrationSource({
      provider: 'Toggl Track',
      account: 'Demo Toggl workspace (fixture, no network)',
      description: p['toggl-description'],
      start: p['toggl-start'],
      end: p['toggl-stop'],
      billable: p['toggl-billable'],
      bindingClass: pieces.classes['sync-binding'],
      syncedTable: pieces.properties['synced-table'],
      syncState: pieces.properties['sync-state'],
      name: core.properties.name,
    }),
  });
  await setProps(store, toggl.app, {
    [pieces.properties['piece-kind']]: 'integration',
    [pieces.properties['piece-provider']]: 'toggl',
  });
  await handOver(store, drive, toggl);

  return {
    hours,
    groceries,
    clockifyMirror: clockify.data,
    timesheet: timesheet.app,
    clockify: clockify.app,
    lens,
    toggl: toggl.app,
    togglLens,
  };
}

async function handOver(
  store: Store,
  drive: string,
  created: { app: string; secret: string },
) {
  // The app stays usable for reading if this fails; it only cannot write.
  try {
    await handOverAppKey(store, {
      drive,
      app: created.app,
      secret: created.secret,
    });
  } catch (error) {
    store.notifyError(error);
  }
}
