import { describe, expect, it } from 'vitest';
import { githubViewsForClass, selectableViewKinds } from './githubViews';

const classes = {
  'syncable-owner': 'atomic:class:owners-in-this-drive',
  'syncable-repository': 'atomic:class:repositories-in-this-drive',
};

describe('GitHub view applicability', () => {
  it('offers organizations and repositories only for the matching class subjects', () => {
    expect(githubViewsForClass(classes, classes['syncable-owner'])).toEqual([
      'github-organizations',
    ]);
    expect(
      githubViewsForClass(classes, classes['syncable-repository']),
    ).toEqual(['github-repositories']);
    expect(githubViewsForClass(classes, 'atomic:class:syncable-owner')).toEqual(
      [],
    );
    expect(githubViewsForClass(classes, 'atomic:class:invoice')).toEqual([]);
  });

  it('offers neither view before the schema or row class is known', () => {
    expect(githubViewsForClass(undefined, classes['syncable-owner'])).toEqual(
      [],
    );
    expect(githubViewsForClass(classes, undefined)).toEqual([]);
  });

  it('keeps Table available while scoping the manual choices', () => {
    expect(selectableViewKinds([])).toContain('table');
    expect(selectableViewKinds([])).not.toContain('syncables');
    expect(selectableViewKinds([])).not.toContain('github-organizations');
    expect(selectableViewKinds([])).not.toContain('github-repositories');
    expect(selectableViewKinds(['github-organizations'])).toContain(
      'github-organizations',
    );
    expect(selectableViewKinds(['github-organizations'])).not.toContain(
      'github-repositories',
    );
  });
});
