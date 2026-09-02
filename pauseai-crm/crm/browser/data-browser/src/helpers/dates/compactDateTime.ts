import { formatTimeAgo } from '../formatTimeAgo';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A compact, human timestamp for dense lists (chat, comments): "5 minutes
 * ago" / "yesterday" for the last week, "Jul 1" earlier in the same year,
 * and a short numeric date ("2/15/2021") for older dates. Keeps the label a
 * few characters wide so it never crowds out the message meta.
 */
export function formatCompactDateTime(date: Date): string {
  const diff = Math.abs(Date.now() - date.getTime());

  if (diff < WEEK_MS) {
    return formatTimeAgo(date) ?? date.toLocaleDateString();
  }

  if (date.getFullYear() === new Date().getFullYear()) {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }

  return date.toLocaleDateString();
}
