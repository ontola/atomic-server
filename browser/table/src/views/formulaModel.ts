import type { DerivedValueKind } from './configuration.js';

/** Infer the display kind from the expression and its bound column types. */
export function inferTableDerivedValueKind(
  formula: string,
  /** Whether every column the formula reads is a date or a datetime. */
  readsInstants: boolean,
): DerivedValueKind | undefined {
  const operand = String.raw`(?:coalesce\((?:[^()]|\(\))*\)|\w+|now\(\))`;

  if (/[<>]=?|[!=]=|&&|\|\|/.test(formula)) {
    return 'boolean';
  }

  if (
    readsInstants &&
    new RegExp(`^\\s*${operand}\\s*-\\s*${operand}\\s*$`).test(formula)
  ) {
    return 'duration';
  }

  return /^\s*days\(.*\)\s*$/.test(formula)
    ? 'days'
    : /^\s*addDays\(.*\)\s*$/.test(formula)
      ? 'date'
      : undefined;
}

/** A human column label as a formula identifier. */
export const tableFormulaColumnSlug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'c$1') || 'column';

/**
 * Identifier → property subject for columns given as `[label, subject]`. Two
 * labels that slug alike get a numeric suffix (`price`, `price_2`); the same
 * column listed twice (say by name and by shortname) keeps one entry.
 */
export function tableFormulaColumnSlugs(
  columns: ReadonlyArray<readonly [label: string, subject: string]>,
): Record<string, string> {
  const slugs: Record<string, string> = {};

  for (const [label, subject] of columns) {
    const base = tableFormulaColumnSlug(label);
    let slug = base;

    for (let n = 2; slugs[slug] !== undefined && slugs[slug] !== subject; n++) {
      slug = `${base}_${n}`;
    }

    slugs[slug] = subject;
  }

  return slugs;
}

/** `evalexpr` names that are not columns: literals, and anything called. */
const NOT_COLUMNS = new Set(['true', 'false']);

/** The column identifiers a formula reads — not function names or literals. */
export function tableFormulaIdentifiers(formula: string): string[] {
  // The character before is matched as a group, not a lookbehind: Safari
  // before 16.4 rejects a lookbehind literal, and the whole bundle with it.
  const identifiers = formula
    .replace(/"[^"]*"/g, '')
    .matchAll(/(^|[^\w:])([A-Za-z_]\w*)(?!\s*\(|\w|::)/g);

  return [...new Set([...identifiers].map(m => m[2]))].filter(
    name => !NOT_COLUMNS.has(name),
  );
}

/**
 * Binds the identifiers a formula uses to property subjects. An identifier that
 * names no column comes back in `unknown`, with the closest column to suggest.
 */
export function bindTableFormula(
  formula: string,
  slugs: Record<string, string>,
): { vars: Record<string, string>; unknown: Array<[string, string?]> } {
  const vars: Record<string, string> = {};
  const unknown: Array<[string, string?]> = [];

  for (const name of tableFormulaIdentifiers(formula)) {
    if (slugs[name]) {
      vars[name] = slugs[name];
    } else {
      unknown.push([name, closest(name, Object.keys(slugs))]);
    }
  }

  return { vars, unknown };
}

function closest(name: string, candidates: string[]): string | undefined {
  const distance = (a: string, b: string): number => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
      const next = [i];

      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(
          row[j] + 1,
          next[j - 1] + 1,
          row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }

      row = next;
    }

    return row[b.length];
  };

  const [best] = candidates.sort(
    (x, y) => distance(name, x) - distance(name, y),
  );

  return best && distance(name, best) <= Math.max(2, name.length / 2)
    ? best
    : undefined;
}
