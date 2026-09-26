import { describe, expect, it } from 'vitest';
import { dropSaved, stillUnconfirmed } from './useIntegrationVisibility';

describe('dropSaved', () => {
  it('drops saved values and keeps ones toggled again mid-flight', () => {
    expect(
      dropSaved(
        { 'show-api-plugins': false, 'show-experimental-plugins': true },
        [
          ['show-api-plugins', true],
          ['show-experimental-plugins', true],
        ],
      ),
    ).toEqual({ 'show-api-plugins': false });
  });
});

describe('stillUnconfirmed', () => {
  it('confirms saved keys but not ones re-toggled mid-flight', () => {
    const saved: ['show-api-plugins' | 'show-experimental-plugins', boolean][] =
      [
        ['show-api-plugins', true],
        ['show-experimental-plugins', true],
      ];
    const remaining = dropSaved(
      { 'show-api-plugins': false, 'show-experimental-plugins': true },
      saved,
    );

    expect(
      stillUnconfirmed(
        ['show-api-plugins', 'show-experimental-plugins'],
        saved,
        remaining,
      ),
    ).toEqual(['show-api-plugins']);
  });

  it('keeps keys that were not part of the write', () => {
    expect(
      stillUnconfirmed(
        ['show-experimental-plugins'],
        [['show-api-plugins', true]],
        {},
      ),
    ).toEqual(['show-experimental-plugins']);
  });
});
