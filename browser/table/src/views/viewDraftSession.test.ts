import { expect, it } from 'vitest';
import { createTableViewDraftSession } from './viewDraftSession.js';

const source = (name = 'Original', revision: string | undefined = 'v1') => ({
  value: { name, filter: '' },
  revision,
});
it('keeps independent scoped drafts and reads incoming pristine sources directly', () => {
  const session = createTableViewDraftSession<{
    name: string;
    filter: string;
  }>();
  session.edit('table-a/view', source(), value => ({ ...value, filter: 'A' }));
  session.edit('table-b/view', source(), value => ({ ...value, filter: 'B' }));
  expect(session.read('table-a/view', source('Incoming', 'v2'))).toMatchObject({
    value: { filter: 'A' },
    conflict: true,
    dirty: true,
  });
  expect(session.read('table-b/view', source()).value.filter).toBe('B');
  expect(
    session.read('table-c/view', source('Incoming', 'v2')).value.name,
  ).toBe('Incoming');
  session.discard('table-a/view');
  expect(
    session.read('table-a/view', source('Incoming', 'v2')).value.name,
  ).toBe('Incoming');
  expect(session.getSnapshot().draftCount).toBe(1);
});
it('retains a failed intent, blocks concurrent saves and prevents edits during an explicit save', () => {
  const session = createTableViewDraftSession<{
    name: string;
    filter: string;
  }>();
  const save = session.begin('view', source())!;
  expect(session.begin('other', source())).toBeUndefined();
  expect(session.edit('view', source(), value => value)).toBe(false);
  expect(session.discardAll()).toBe(false);
  session.fail(save, Error('offline'));
  expect(session.read('view', source())).toMatchObject({
    dirty: true,
    error: { message: 'offline' },
  });
  const retry = session.begin('view', source())!;
  expect(retry.value).toEqual(save.value);
  session.finish(retry, source('Original', 'v2'));
  expect(session.getSnapshot()).toMatchObject({ busy: false, draftCount: 0 });
});
it('rebases only edits made during a save onto the confirmed source', () => {
  const session = createTableViewDraftSession<{ name: string; filter: string }>(
    {
      allowEditsWhileSaving: true,
      rebase: (current, submitted, confirmed) => ({
        name: current.name !== submitted.name ? current.name : confirmed.name,
        filter:
          current.filter !== submitted.filter
            ? current.filter
            : confirmed.filter,
      }),
    },
  );
  session.edit('view', source(), value => ({ ...value, filter: 'first' }));
  const save = session.begin('view', source())!;
  session.edit('view', source(), value => ({ ...value, filter: 'latest' }));
  save.value.name = 'Backend mutation of its snapshot';
  session.finish(save, {
    value: { name: 'Incoming name', filter: 'first' },
    revision: 'v2',
  });
  expect(session.read('view', source('Incoming name', 'v2'))).toMatchObject({
    value: { name: 'Incoming name', filter: 'latest' },
    dirty: true,
    conflict: false,
  });
  save.value.filter = 'mutated backend snapshot';
  expect(session.read('view', source()).value.filter).toBe('latest');
});
it('carries an implicit draft through preparation and keeps newer edits only on the confirmed target', () => {
  const session = createTableViewDraftSession<{ name: string; filter: string }>(
    { allowEditsWhileSaving: true, rebase: current => current },
  );
  session.edit('implicit', source(), value => ({ ...value, filter: 'first' }));
  const save = session.begin('implicit', source())!;
  session.alias('implicit', 'prepared-view');
  session.edit('prepared-view', source(), value => ({
    ...value,
    filter: 'latest',
  }));
  expect(session.getSnapshot().draftCount).toBe(1);
  expect(session.read('implicit', source()).value.filter).toBe('latest');
  session.finish(
    save,
    { value: save.value, revision: 'created' },
    'prepared-view',
  );
  expect(session.read('implicit', source()).dirty).toBe(false);
  expect(
    session.read('prepared-view', { value: save.value, revision: 'created' }),
  ).toMatchObject({
    value: { filter: 'latest' },
    dirty: true,
    conflict: false,
  });
});
it('does not merge a prepared view into an unrelated draft or accept a late completion token', () => {
  const session = createTableViewDraftSession<{
    name: string;
    filter: string;
  }>();
  session.edit('one', source(), value => ({ ...value, filter: 'one' }));
  session.edit('two', source(), value => ({ ...value, filter: 'two' }));
  expect(() => session.alias('one', 'two')).toThrow(/already has a draft/);
  const first = session.begin('one', source())!;
  session.fail(first, Error('offline'));
  const second = session.begin('two', source())!;
  expect(session.finish(first, source())).toBe(false);
  expect(session.getSnapshot().busy).toBe(true);
  session.finish(second, source());
  expect(session.read('one', source()).value.filter).toBe('one');
});

it('allows independent immediate-save scopes without accepting another session token', () => {
  const session = createTableViewDraftSession<{ name: string; filter: string }>(
    { concurrentScopes: true },
  );
  const otherSession = createTableViewDraftSession<{
    name: string;
    filter: string;
  }>();
  const a = session.begin('a', source())!;
  const b = session.begin('b', source())!;
  const foreign = otherSession.begin('a', source())!;
  expect(session.finish(foreign, source())).toBe(false);
  session.finish(a, source());
  expect(session.getSnapshot().busy).toBe(true);
  expect(session.read('b', source()).dirty).toBe(true);
  session.finish(b, source());
  expect(session.getSnapshot().busy).toBe(false);
});

it('resumes the failed captured value and retains newer edits after confirmation', () => {
  const session = createTableViewDraftSession<{ name: string; filter: string }>(
    { allowEditsWhileSaving: true, rebase: current => current },
  );
  session.edit('view', source(), value => ({ ...value, filter: 'submitted' }));
  const save = session.begin('view', source())!;
  session.fail(save, Error('offline'));
  session.edit('view', source(), value => ({ ...value, filter: 'newer' }));
  expect(session.resume(save)).toBe(true);
  expect(save.value.filter).toBe('submitted');
  session.finish(save, { value: save.value, revision: 'v2' });
  expect(
    session.read('view', { value: save.value, revision: 'v2' }),
  ).toMatchObject({ value: { filter: 'newer' }, conflict: false, dirty: true });
  expect(session.resume(save)).toBe(false);
});
it('moves an attached draft without changing the save identity or leaving an implicit alias', () => {
  const session = createTableViewDraftSession<{
    name: string;
    filter: string;
  }>();
  const save = session.begin('implicit', source())!;
  session.alias('implicit', 'created');
  session.move('implicit', 'created');
  expect(session.read('implicit', source()).dirty).toBe(false);
  expect(session.read('created', source()).dirty).toBe(true);
  session.finish(save, source(), 'created');
  expect(session.getSnapshot().draftCount).toBe(0);
});
