import { describe, expect, it } from 'vitest';
import { appsForClass } from '@chunks/AppPage/useDriveApps';
import { offersForTable, type LensInfo, type PieceInfo } from './offers';

const TIME_ENTRY = 'https://drive.example/classes/time-entry';
const CLOCKIFY = 'https://drive.example/classes/clockify-time-entry';
const TEMPLATE = 'https://drive.example/classes/time-tracker-row';
const GROCERY = 'https://drive.example/classes/grocery-item';
const FAR = 'https://drive.example/classes/far-away';
const TOGGL = 'https://drive.example/classes/toggl-time-entry';

const timesheet: PieceInfo = {
  subject: 'https://drive.example/apps/timesheet',
  name: 'Timesheet',
  kind: 'view',
  renders: [TIME_ENTRY],
};

const clockify: PieceInfo = {
  subject: 'https://drive.example/apps/clockify',
  name: 'Clockify',
  kind: 'integration',
  renders: [CLOCKIFY],
};

const entryToClockify: LensInfo = {
  subject: 'https://drive.example/lenses/entry-clockify',
  name: 'Time entry ↔ Clockify time entry',
  source: TIME_ENTRY,
  target: CLOCKIFY,
  trusted: true,
};

const templateToEntry: LensInfo = {
  subject: 'https://drive.example/lenses/template-entry',
  name: 'Time tracker row ↔ Time entry',
  source: TEMPLATE,
  target: TIME_ENTRY,
  trusted: true,
};

const farToTemplate: LensInfo = {
  subject: 'https://drive.example/lenses/far-template',
  name: 'Far ↔ Time tracker row',
  source: FAR,
  target: TEMPLATE,
  trusted: true,
};

const names = (offers: ReturnType<typeof offersForTable>) =>
  offers.map(o => o.piece.name);

describe('offersForTable', () => {
  it('offers a view on a table of its row class, with no lens', () => {
    const offers = offersForTable([timesheet, clockify], [], TIME_ENTRY);

    expect(names(offers)).toEqual(['Timesheet']);
    expect(offers[0].path).toEqual([]);
  });

  it('offers an integration through a lens to its native class', () => {
    const offers = offersForTable(
      [timesheet, clockify],
      [entryToClockify],
      TIME_ENTRY,
    );

    expect(names(offers)).toEqual(['Timesheet', 'Clockify']);
    expect(offers[1].path).toEqual([
      { lens: entryToClockify.subject, direction: 'forward' },
    ]);
    expect(offers[1].classes).toEqual([TIME_ENTRY, CLOCKIFY]);
  });

  it('walks a lens backwards: lenses are two-way', () => {
    const toEntry: PieceInfo = { ...clockify, renders: [TIME_ENTRY] };
    const offers = offersForTable([toEntry], [entryToClockify], CLOCKIFY);

    expect(offers[0].path).toEqual([
      { lens: entryToClockify.subject, direction: 'backward' },
    ]);
  });

  it('does not offer a view through a lens', () => {
    const offers = offersForTable(
      [timesheet, clockify],
      [entryToClockify],
      CLOCKIFY,
    );

    expect(names(offers)).toEqual(['Clockify']);
  });

  it('chains lenses up to the hop limit', () => {
    const lenses = [entryToClockify, templateToEntry, farToTemplate];

    const fromTemplate = offersForTable([clockify], lenses, TEMPLATE);
    expect(fromTemplate[0].classes).toEqual([TEMPLATE, TIME_ENTRY, CLOCKIFY]);

    // Three hops away: past the default limit of two.
    expect(offersForTable([clockify], lenses, FAR)).toEqual([]);
    expect(
      names(offersForTable([clockify], lenses, FAR, { maxHops: 3 })),
    ).toEqual(['Clockify']);
  });

  it('prefers the shortest path when a piece accepts several classes', () => {
    const both: PieceInfo = { ...clockify, renders: [CLOCKIFY, TIME_ENTRY] };
    const offers = offersForTable([both], [entryToClockify], TIME_ENTRY);

    expect(offers[0].path).toEqual([]);
  });

  it('offers nothing on an unrelated table', () => {
    expect(
      offersForTable([timesheet, clockify], [entryToClockify], GROCERY),
    ).toEqual([]);
    expect(offersForTable([timesheet], [], undefined)).toEqual([]);
  });

  it('offers several integrations on one table, each on its own path', () => {
    const toggl: PieceInfo = {
      subject: 'https://drive.example/apps/toggl',
      name: 'Toggl',
      kind: 'integration',
      renders: [TOGGL],
    };
    const entryToToggl: LensInfo = {
      subject: 'https://drive.example/lenses/entry-toggl',
      name: 'Time entry ↔ Toggl time entry',
      source: TIME_ENTRY,
      target: TOGGL,
      trusted: true,
    };
    const offers = offersForTable(
      [clockify, toggl],
      [entryToClockify, entryToToggl],
      TIME_ENTRY,
    );

    expect(names(offers)).toEqual(['Clockify', 'Toggl']);
    expect(offers.every(o => o.pendingReview.length === 0)).toBe(true);
  });

  it('holds back an integration behind an unreviewed lens', () => {
    const unreviewed = { ...entryToClockify, trusted: false };
    const offers = offersForTable([clockify], [unreviewed], TIME_ENTRY);

    expect(names(offers)).toEqual(['Clockify']);
    expect(offers[0].pendingReview).toEqual([entryToClockify.subject]);
  });

  it('names only the unreviewed lenses of a chain', () => {
    const offers = offersForTable(
      [clockify],
      [entryToClockify, { ...templateToEntry, trusted: false }],
      TEMPLATE,
    );

    expect(offers[0].pendingReview).toEqual([templateToEntry.subject]);
  });

  it('prefers a reviewed path over a shorter unreviewed one', () => {
    const shortcut: LensInfo = {
      subject: 'https://drive.example/lenses/template-clockify',
      name: 'Time tracker row ↔ Clockify time entry',
      source: TEMPLATE,
      target: CLOCKIFY,
      trusted: false,
    };
    const offers = offersForTable(
      [clockify],
      [shortcut, entryToClockify, templateToEntry],
      TEMPLATE,
    );

    expect(offers[0].pendingReview).toEqual([]);
    expect(offers[0].path).toHaveLength(2);
  });

  it('agrees with appsForClass when there are only views and no lenses', () => {
    const apps = [
      { subject: 'a', name: 'A', renders: [TIME_ENTRY] },
      { subject: 'b', name: 'B', renders: [GROCERY] },
      { subject: 'c', name: 'C', renders: [] },
    ];
    const pieces = apps.map(app => ({ ...app, kind: 'view' as const }));

    for (const rowClass of [TIME_ENTRY, GROCERY, CLOCKIFY]) {
      expect(
        offersForTable(pieces, [], rowClass).map(o => o.piece.subject),
      ).toEqual(appsForClass(apps, rowClass).map(a => a.subject));
    }
  });
});
