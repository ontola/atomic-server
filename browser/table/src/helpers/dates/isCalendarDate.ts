/** Civil-date validation without an Atomic Store or time-zone conversion. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value + 'T00:00:00.000Z');

  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
