import { taskSchema } from '@tomic/lib';

/**
 * Tag titles that mean "this issue is closed". Matched case-insensitively
 * against the status tag's title, so a board that calls its last column
 * "Complete" or "Resolved" still reads as an issue tracker. The shared task
 * vocabulary's `Done` tag is closed by subject, whatever it is titled.
 */
const CLOSED_TITLES =
  /^(done|closed|complete|completed|resolved|cancelled|canceled|won'?t fix)$/i;

export interface IssueStatusTag {
  subject: string;
  title: string;
  closed: boolean;
}

export function isClosedStatusTag(subject: string, title: string): boolean {
  return subject === taskSchema.tags.Done || CLOSED_TITLES.test(title.trim());
}

/**
 * What decides whether an issue is open or closed. A `select` status column
 * (Todo / Doing / Done — the kanban's group-by) is the native tracker's shape;
 * a `boolean` column is what a read-only import offers when the provider only
 * says checked or not.
 */
export type IssueStatusModel =
  | {
      kind: 'select';
      property: string;
      /** Where a new or reopened issue lands: the first open tag, in option order. */
      openTag: string | undefined;
      /** Where "Close" puts it: the first closed tag. */
      closedTag: string | undefined;
      closedTags: Set<string>;
    }
  | { kind: 'boolean'; property: string };

/** Splits a status property's tags into open and closed and builds the model. */
export function selectStatusModel(
  property: string,
  tags: IssueStatusTag[],
): IssueStatusModel {
  return {
    kind: 'select',
    property,
    openTag: tags.find(t => !t.closed)?.subject,
    closedTag: tags.find(t => t.closed)?.subject,
    closedTags: new Set(tags.filter(t => t.closed).map(t => t.subject)),
  };
}

/** Whether a row counts as closed, from its status value. */
export function isIssueClosed(
  model: IssueStatusModel,
  value: unknown,
): boolean {
  if (model.kind === 'boolean') return value === true;

  return Array.isArray(value) && value.some(tag => model.closedTags.has(tag));
}

/**
 * The status value that makes a row open or closed, or undefined when the
 * model has no tag on that side (a select with no Done option cannot close).
 */
export function statusValueFor(
  model: IssueStatusModel,
  closed: boolean,
): string[] | boolean | undefined {
  if (model.kind === 'boolean') return closed;
  const tag = closed ? model.closedTag : model.openTag;

  return tag ? [tag] : undefined;
}

/**
 * The status tags worth a pill next to the title: "Doing" or "Blocked" say
 * something the open/closed icon does not; the default open tag and any
 * closed tag do not. A boolean status has no pills.
 */
export function statusPills(model: IssueStatusModel, value: unknown): string[] {
  if (model.kind === 'boolean' || !Array.isArray(value)) return [];

  return value.filter(
    (tag): tag is string =>
      typeof tag === 'string' &&
      tag !== model.openTag &&
      !model.closedTags.has(tag),
  );
}

/**
 * Case-insensitive substring match of the filter box against a title and an
 * optional `#number`, GitHub-style: "42" and "#42" both find issue 42.
 */
export function matchesIssueFilter(
  filter: string,
  title: string,
  number: number | undefined,
): boolean {
  const needle = filter.trim().toLowerCase();

  if (!needle) return true;
  if (title.toLowerCase().includes(needle)) return true;

  return (
    number !== undefined && `#${number}`.includes(needle.replace(/^#?/, '#'))
  );
}
