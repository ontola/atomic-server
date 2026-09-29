import { describe, expect, it } from 'vitest';
import {
  dateFieldOrder,
  dateInputPlaceholder,
  formatDateInput,
  parseDateInput,
} from './dateInput';

describe('parseDateInput', () => {
  it('reads year-first dates without zero padding', () => {
    expect(parseDateInput('2026-10-2')).toBe('2026-10-02');
    expect(parseDateInput('2026-1-2')).toBe('2026-01-02');
    expect(parseDateInput('2026/10/02')).toBe('2026-10-02');
    expect(parseDateInput(' 2026-10-02 ')).toBe('2026-10-02');
  });

  it("reads the locale's order: day first in en-GB, month first in en-US", () => {
    expect(parseDateInput('2/10/2026', 'en-GB')).toBe('2026-10-02');
    expect(parseDateInput('2/10/2026', 'en-US')).toBe('2026-02-10');
    expect(parseDateInput('2.10.2026', 'de-DE')).toBe('2026-10-02');
    expect(parseDateInput('2-10-2026', 'nl-NL')).toBe('2026-10-02');
  });

  it('reads eight bare digits like the old native input took them', () => {
    expect(parseDateInput('02102026', 'en-GB')).toBe('2026-10-02');
    expect(parseDateInput('10022026', 'en-US')).toBe('2026-10-02');
    // Not a day-month-year date, so read as year first.
    expect(parseDateInput('20261002', 'en-GB')).toBe('2026-10-02');
  });

  it('rejects dates that do not exist', () => {
    expect(parseDateInput('2026-02-30')).toBeUndefined();
    expect(parseDateInput('2026-13-01')).toBeUndefined();
    expect(parseDateInput('31/4/2026', 'en-GB')).toBeUndefined();
    expect(parseDateInput('29/2/2028', 'en-GB')).toBe('2028-02-29');
  });

  it('rejects partial and ambiguous input instead of guessing', () => {
    expect(parseDateInput('')).toBeUndefined();
    expect(parseDateInput('2026-10')).toBeUndefined();
    expect(parseDateInput('2/10/26', 'en-GB')).toBeUndefined();
    expect(parseDateInput('2/10/202', 'en-GB')).toBeUndefined();
    expect(parseDateInput('next friday')).toBeUndefined();
    expect(parseDateInput('2026-10-2x')).toBeUndefined();
  });
});

describe('formatDateInput', () => {
  it('writes a stored date the way the locale reads it back', () => {
    expect(formatDateInput('2026-10-02', 'en-GB')).toBe('02/10/2026');
    expect(
      parseDateInput(formatDateInput('2026-10-02', 'en-GB'), 'en-GB'),
    ).toBe('2026-10-02');
    expect(
      parseDateInput(formatDateInput('2026-10-02', 'en-US'), 'en-US'),
    ).toBe('2026-10-02');
    expect(
      parseDateInput(formatDateInput('2026-10-02', 'de-DE'), 'de-DE'),
    ).toBe('2026-10-02');
  });

  it('leaves an empty or odd value as text', () => {
    expect(formatDateInput(undefined, 'en-GB')).toBe('');
    expect(formatDateInput('soon', 'en-GB')).toBe('soon');
  });
});

it('describes the locale pattern', () => {
  expect(dateFieldOrder('en-GB')).toEqual(['day', 'month', 'year']);
  expect(dateFieldOrder('en-US')).toEqual(['month', 'day', 'year']);
  expect(dateInputPlaceholder('en-GB')).toBe('dd/mm/yyyy');
  expect(dateInputPlaceholder('de-DE')).toBe('dd.mm.yyyy');
});
