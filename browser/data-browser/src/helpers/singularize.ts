/**
 * Naive English singularization, used to suggest a row-class name from a table
 * name ("Employees" → "Employee", "Companies" → "Company"). Heuristic only —
 * the result is always shown in an editable field, so a wrong guess is a
 * one-word fix, never a silent mistake.
 */
export function singularize(word: string): string {
  const trimmed = word.trim();

  if (/[A-Za-z]ies$/.test(trimmed)) {
    return trimmed.replace(/ies$/, 'y');
  }

  // Words ending in 'ss' (class), 'us' (status) or 'is' (analysis) are
  // usually already singular.
  if (/(ss|us|is)$/i.test(trimmed)) {
    return trimmed;
  }

  if (/[A-Za-z]s$/.test(trimmed)) {
    return trimmed.slice(0, -1);
  }

  return trimmed;
}
