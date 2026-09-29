import { describe, expect, it } from 'vitest';
import { taskSchema } from '@tomic/lib';
import {
  isClosedStatusTag,
  isIssueClosed,
  matchesIssueFilter,
  selectStatusModel,
  statusPills,
  statusValueFor,
} from './issueStatus';

describe('issue status tags', () => {
  it('reads Done, Closed and friends as closed, whatever the case', () => {
    for (const title of ['Done', 'done', 'Closed', 'Resolved', "Won't fix"]) {
      expect(isClosedStatusTag('tag:x', title)).toBe(true);
    }

    for (const title of ['Todo', 'Doing', 'Blocked', 'In review']) {
      expect(isClosedStatusTag('tag:x', title)).toBe(false);
    }
  });

  it('reads the shared task vocabulary Done tag as closed by subject', () => {
    expect(isClosedStatusTag(taskSchema.tags.Done, 'Finished')).toBe(true);
  });

  it('picks the first open tag to reopen into and the first closed tag to close into', () => {
    const model = selectStatusModel('status', [
      { subject: 'todo', title: 'Todo', closed: false },
      { subject: 'doing', title: 'Doing', closed: false },
      { subject: 'done', title: 'Done', closed: true },
    ]);

    expect(statusValueFor(model, false)).toEqual(['todo']);
    expect(statusValueFor(model, true)).toEqual(['done']);
    expect(isIssueClosed(model, ['done'])).toBe(true);
    expect(isIssueClosed(model, ['doing'])).toBe(false);
    expect(isIssueClosed(model, undefined)).toBe(false);
    // Todo is implied by the open icon, Done by the closed one; Doing is news.
    expect(statusPills(model, ['todo'])).toEqual([]);
    expect(statusPills(model, ['doing'])).toEqual(['doing']);
    expect(statusPills(model, ['done'])).toEqual([]);
  });

  it('cannot close into a select that has no closed option', () => {
    const model = selectStatusModel('status', [
      { subject: 'todo', title: 'Todo', closed: false },
    ]);

    expect(statusValueFor(model, true)).toBeUndefined();
    expect(statusValueFor(model, false)).toEqual(['todo']);
  });

  it('reads a boolean status as checked means closed', () => {
    const model = { kind: 'boolean', property: 'done' } as const;

    expect(isIssueClosed(model, true)).toBe(true);
    expect(isIssueClosed(model, false)).toBe(false);
    expect(isIssueClosed(model, undefined)).toBe(false);
    expect(statusValueFor(model, true)).toBe(true);
    expect(statusValueFor(model, false)).toBe(false);
    expect(statusPills(model, true)).toEqual([]);
  });

  it('filters by title or by #number', () => {
    expect(matchesIssueFilter('', 'Anything', 1)).toBe(true);
    expect(matchesIssueFilter('crash', 'Login CRASH on iOS', 7)).toBe(true);
    expect(matchesIssueFilter('#7', 'Login crash', 7)).toBe(true);
    expect(matchesIssueFilter('7', 'Login crash', 7)).toBe(true);
    expect(matchesIssueFilter('8', 'Login crash', 7)).toBe(false);
    expect(matchesIssueFilter('7', 'Login crash', undefined)).toBe(false);
  });
});
