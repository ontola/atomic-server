// Demo seeds, run inside the page (see uxLogClient.js `__demoSeed`). Loaded as
// a Vite virtual module, so imports resolve like the data-browser's own and
// everything is created through the app's normal creation paths.
//
// Plain JS on purpose: virtual modules skip the TS transform.
import { core, commits, Datatype } from '@tomic/react';
import { buildTableFromSpec } from '@chunks/TablePage/createTableFromSpec';
import { createPropertyOnClass } from '@chunks/TablePage/Kanban/createSelectProperty';
import { addToOntology } from '@chunks/Demo/demoWorkspace';
import { constructOpenURL } from '@helpers/navigation';

const SEEDS = { calendar: seedCalendar };

export async function seed(store, name, drive) {
  const run = SEEDS[name];
  if (!run)
    throw new Error(`Unknown seed "${name}"; known: ${Object.keys(SEEDS)}`);

  return run(store, drive);
}

const CALENDAR_ID = 'team@demo.example';
const AMS = 'Europe/Amsterdam';
const NYC = 'America/New_York';

/** Rows of the "Team calendar" table. `recurrence` rows carry a
 * Google-Calendar-shaped event, the format the calendar view expands. */
const TEAM_EVENTS = [
  // --- Recurring (the view expands these) ---
  {
    name: 'Team standup',
    day: '2026-09-07',
    notes: 'Mon/Wed/Fri 09:30–09:45 Amsterdam until 18 Dec. Skipped 9 Oct.',
    event: {
      id: 'standup',
      summary: 'Team standup',
      start: { dateTime: '2026-09-07T09:30:00+02:00', timeZone: AMS },
      end: { dateTime: '2026-09-07T09:45:00+02:00', timeZone: AMS },
      recurrence: [
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261218T235959Z',
        `EXDATE;TZID=${AMS}:20261009T093000`,
      ],
    },
  },
  {
    // One instance of the standup moved from Wed 14 Oct to Thu 15 Oct.
    name: 'Team standup',
    day: '2026-10-15',
    notes: 'Moved from Wednesday 14 Oct.',
    event: {
      id: 'standup_20261014T073000Z',
      summary: 'Team standup',
      recurringEventId: 'standup',
      originalStartTime: { dateTime: '2026-10-14T09:30:00+02:00', timeZone: AMS },
      start: { dateTime: '2026-10-15T10:00:00+02:00', timeZone: AMS },
      end: { dateTime: '2026-10-15T10:15:00+02:00', timeZone: AMS },
    },
  },
  {
    name: 'Sprint review',
    day: '2026-09-10',
    notes: 'Every other Thursday 15:00, six times.',
    event: {
      id: 'sprint-review',
      summary: 'Sprint review',
      start: { dateTime: '2026-09-10T15:00:00+02:00', timeZone: AMS },
      end: { dateTime: '2026-09-10T16:00:00+02:00', timeZone: AMS },
      recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;COUNT=6'],
    },
  },
  {
    name: '1:1 with manager',
    day: '2026-09-01',
    notes: 'First Tuesday of the month, 11:00.',
    event: {
      id: 'one-on-one',
      summary: '1:1 with manager',
      start: { dateTime: '2026-09-01T11:00:00+02:00', timeZone: AMS },
      end: { dateTime: '2026-09-01T11:30:00+02:00', timeZone: AMS },
      recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=1TU'],
    },
  },
  {
    name: 'Late sync with Boston',
    day: '2026-09-15',
    notes:
      'Tuesdays 19:30 New York, which is 01:30 Wednesday in Amsterdam. Ten times.',
    event: {
      id: 'boston-sync',
      summary: 'Late sync with Boston',
      start: { dateTime: '2026-09-15T19:30:00-04:00', timeZone: NYC },
      end: { dateTime: '2026-09-15T20:30:00-04:00', timeZone: NYC },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10'],
    },
  },
  {
    name: 'Payday',
    day: '2026-01-25',
    allDay: true,
    endDay: '2026-01-26',
    notes: 'All day, the 25th of every month.',
    event: {
      id: 'payday',
      summary: 'Payday',
      start: { date: '2026-01-25' },
      end: { date: '2026-01-26' },
      recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=25'],
    },
  },
  {
    name: 'Quarterly planning',
    day: '2026-07-06',
    allDay: true,
    endDay: '2026-07-08',
    notes: 'Two days from the first Monday of every third month.',
    event: {
      id: 'quarterly-planning',
      summary: 'Quarterly planning',
      start: { date: '2026-07-06' },
      end: { date: '2026-07-08' },
      recurrence: ['RRULE:FREQ=MONTHLY;INTERVAL=3;BYDAY=1MO'],
    },
  },
  {
    name: "Mila's birthday",
    day: '2019-10-03',
    allDay: true,
    endDay: '2019-10-04',
    event: {
      id: 'mila-birthday',
      summary: "Mila's birthday",
      start: { date: '2019-10-03' },
      end: { date: '2019-10-04' },
      recurrence: ['RRULE:FREQ=YEARLY'],
    },
  },

  // --- Single events ---
  { name: 'Invoice due', day: '2026-09-25' },
  { name: 'Dentist', day: '2026-09-28', notes: '14:00' },
  { name: 'Release 0.41', day: '2026-10-01' },
  {
    name: 'Offsite in Ghent',
    day: '2026-10-06',
    allDay: true,
    endDay: '2026-10-09',
    notes: 'Tuesday to Thursday. End day is exclusive.',
  },
  {
    name: 'Clocks go back',
    day: '2026-10-25',
    allDay: true,
    endDay: '2026-10-26',
    notes: 'Europe leaves summer time; New York follows on 1 November.',
  },
  {
    name: 'Autumn holiday',
    day: '2026-10-29',
    allDay: true,
    endDay: '2026-11-03',
    notes: 'Thursday 29 Oct to Monday 2 Nov, across the month boundary.',
  },
  {
    name: 'Office closed',
    day: '2026-11-11',
    allDay: true,
    notes: 'All day, but without an end day.',
  },
  { name: 'Conference talk', day: '2027-01-15' },
  { name: 'Plan the retro', notes: 'Not scheduled yet.' },
];

const CONTENT_PLAN = [
  { name: 'Launch post: calendar view', Channel: 'Blog', 'Publish date': '2026-09-29', Status: 'Scheduled' },
  { name: 'October newsletter', Channel: 'Newsletter', 'Publish date': '2026-10-01', Status: 'Draft' },
  { name: 'Teaser thread', Channel: 'Social', 'Publish date': '2026-09-25', Status: 'Published' },
  { name: 'Case study: Ghent offsite', Channel: 'Blog', 'Publish date': '2026-10-13', Status: 'Draft' },
  { name: 'Recap video', Channel: 'Social', 'Publish date': '2026-10-13', Status: 'Draft' },
  { name: 'November newsletter', Channel: 'Newsletter', 'Publish date': '2026-11-03', Status: 'Draft' },
  { name: 'Year in review', Channel: 'Blog', 'Publish date': '2026-12-21', Status: 'Draft' },
  { name: 'Guest post idea', Channel: 'Blog', Status: 'Draft' },
];

async function seedCalendar(store, drive) {
  const opts = {
    parent: drive,
    driveSubject: drive,
    addToOntology: resource => addToOntology(store, drive, resource),
  };

  // --- Team calendar ---
  const team = await buildTableFromSpec(
    store,
    {
      name: 'Team calendar',
      rowName: 'Event',
      columns: [
        { name: 'Day', type: 'date' },
        { name: 'All day', type: 'checkbox' },
        { name: 'End day', type: 'date' },
        { name: 'Notes', type: 'text' },
      ],
      views: [
        { name: 'Calendar', kind: 'calendar', groupByColumn: 'Day', default: true },
        { name: 'All events', kind: 'table', sortByColumn: 'Day' },
      ],
    },
    opts,
  );

  // The calendar view only reads all-day ranges and recurrence from these
  // shortnames (matchesCalendarField in @tomic/lib calendar-date.ts).
  const shortnames = {
    Day: 'atomic-calendar-day',
    'All day': 'atomic-calendar-all-day',
    'End day': 'atomic-calendar-end-day',
    Notes: 'atomic-calendar-notes',
  };

  for (const [column, shortname] of Object.entries(shortnames)) {
    const property = await store.getResource(team.columns[column]);
    await property.set(core.properties.shortname, shortname);
    await property.save();
  }

  const rowClass = await store.getResource(team.classSubject);
  const recurrence = await createPropertyOnClass(store, rowClass, {
    name: 'Recurrence',
    datatype: Datatype.JSON,
    description: 'The Google-Calendar-shaped event the calendar view expands.',
    propVals: { [core.properties.shortname]: 'atomic-calendar-recurrence' },
  });

  let created = Date.now() - TEAM_EVENTS.length * 1000;

  for (const row of TEAM_EVENTS) {
    const propVals = {
      [core.properties.name]: row.name,
      [commits.properties.createdAt]: created++,
    };
    if (row.day) propVals[team.columns.Day] = row.day;
    if (row.allDay) propVals[team.columns['All day']] = true;
    if (row.endDay) propVals[team.columns['End day']] = row.endDay;
    if (row.notes) propVals[team.columns.Notes] = row.notes;
    if (row.event)
      propVals[recurrence] = { calendarId: CALENDAR_ID, event: row.event };

    const resource = await store.newResource({
      parent: team.tableSubject,
      isA: team.classSubject,
      propVals,
    });
    await resource.save();
  }

  // --- Content plan: has a date column, but no calendar view yet ---
  const content = await buildTableFromSpec(
    store,
    {
      name: 'Content plan',
      rowName: 'Piece',
      columns: [
        { name: 'Channel', type: 'select', options: ['Blog', 'Newsletter', 'Social'] },
        { name: 'Publish date', type: 'date' },
        { name: 'Status', type: 'select', options: ['Draft', 'Scheduled', 'Published'] },
      ],
      views: [{ name: 'All pieces', kind: 'table', default: true }],
      rows: CONTENT_PLAN,
    },
    opts,
  );

  return {
    teamCalendar: team.tableSubject,
    contentPlan: content.tableSubject,
    open: constructOpenURL(team.tableSubject),
  };
}
