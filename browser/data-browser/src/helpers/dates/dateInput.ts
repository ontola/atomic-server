import { isCalendarDate } from '@tomic/react';

type Field = 'day' | 'month' | 'year';

// A day and month that differ in every locale, so their order is unambiguous.
const PROBE = new Date(2000, 10, 22);

const numericFormatter = (locale?: string) =>
  new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    numberingSystem: 'latn',
  });

/** The order the locale writes a numeric date in, e.g. day-month-year. */
export function dateFieldOrder(locale?: string): Field[] {
  return numericFormatter(locale)
    .formatToParts(PROBE)
    .map(part => part.type)
    .filter((type): type is Field =>
      ['day', 'month', 'year'].includes(type as string),
    );
}

const PLACEHOLDER: Record<Field, string> = {
  day: 'dd',
  month: 'mm',
  year: 'yyyy',
};

/** The locale's numeric date pattern, e.g. `dd/mm/yyyy`, as a hint. */
export function dateInputPlaceholder(locale?: string): string {
  return numericFormatter(locale)
    .formatToParts(PROBE)
    .map(part =>
      part.type === 'literal'
        ? part.value
        : (PLACEHOLDER[part.type as Field] ?? ''),
    )
    .join('');
}

/**
 * Reads a typed date as a civil date (`YYYY-MM-DD`), or undefined when it
 * isn't one. Days and months need no leading zero. Accepts year-first
 * (`2026-10-2`) and the locale's own numeric order (`2/10/2026` in en-GB,
 * `10/2/2026` in en-US), with `-`, `/`, `.` or spaces between the parts. The
 * year must have four digits, so `2/10/26` is not guessed at.
 */
export function parseDateInput(
  text: string,
  locale?: string,
): string | undefined {
  const trimmed = text.trim();

  // Eight bare digits, as typed into the old native date input: the locale's
  // order with a two-digit day and month (`02102026`), else year first.
  if (/^\d{8}$/.test(trimmed)) {
    const order = dateFieldOrder(locale);
    const widths: Record<Field, number> = { day: 2, month: 2, year: 4 };
    let at = 0;
    const split = order.map(field => {
      const part = trimmed.slice(at, at + widths[field]);
      at += widths[field];

      return part;
    });

    return (
      (order.length === 3
        ? parseDateInput(split.join('-'), locale)
        : undefined) ??
      parseDateInput(
        `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6)}`,
      )
    );
  }

  const parts = trimmed.split(/[\s./-]+/).filter(Boolean);

  if (parts.length !== 3 || !parts.every(part => /^\d+$/.test(part))) {
    return undefined;
  }

  let order: Field[];

  if (parts[0].length === 4) {
    order = ['year', 'month', 'day'];
  } else {
    order = dateFieldOrder(locale);

    // A locale that writes the year in the middle, or not at all.
    if (order.length !== 3) {
      return undefined;
    }
  }

  const fields = Object.fromEntries(
    order.map((field, i) => [field, parts[i]]),
  ) as Record<Field, string>;

  if (
    fields.year.length !== 4 ||
    fields.month.length > 2 ||
    fields.day.length > 2
  ) {
    return undefined;
  }

  const date = `${fields.year}-${fields.month.padStart(2, '0')}-${fields.day.padStart(2, '0')}`;

  return isCalendarDate(date) ? date : undefined;
}

/** A civil date as the locale writes it numerically, for editing. */
export function formatDateInput(value: unknown, locale?: string): string {
  if (!isCalendarDate(value)) {
    return typeof value === 'string' ? value : '';
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setFullYear(year);

  return numericFormatter(locale).format(date);
}
