/** Parses a local YYYY-MM-DD key as a local date (not UTC midnight). */
function fromDayKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);

  return new Date(year, month - 1, day);
}

/** "Friday 25 September", in the browser's locale. */
export function longDayLabel(dayKey: string): string {
  return fromDayKey(dayKey).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
