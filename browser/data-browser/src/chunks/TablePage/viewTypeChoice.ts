import { TABLE_TEMPLATES } from './tableTemplates';
import {
  appViewOf,
  normalizeViewKind,
  VIEW_KIND_LABELS,
  VIEW_KINDS,
} from './tableViewKinds';

/**
 * What choosing a view type may do to the views a table already has (#1806).
 *
 * The rule is Michiel's: the user should always be able to switch between all
 * the applicable views. So picking a type from a tab's menu adds a view of that
 * type, and never turns the one table view into something else. Changing a
 * view in place is still offered, but only when another view of its type
 * stays behind — nothing the table could show before becomes unreachable.
 */

/**
 * The type a stored `view-kind` stands for, as a comparable key: a built-in
 * kind, or the app's subject. A view with no kind (or an unknown one) is a
 * table, which is what it renders as.
 */
export function viewTypeKey(storedKind: string | undefined): string {
  return appViewOf(storedKind) ?? normalizeViewKind(storedKind);
}

/**
 * Whether `subject` can be changed to another type in place: only when some
 * other view of the same type remains to show the rows that way.
 */
export function canChangeViewType(
  subject: string,
  typesBySubject: ReadonlyMap<string, string>,
): boolean {
  const own = typesBySubject.get(subject);

  if (own === undefined) return false;

  for (const [other, type] of typesBySubject) {
    if (other !== subject && type === own) return true;
  }

  return false;
}

/**
 * Whether `subject` can be deleted without taking the table layout away.
 *
 * The last saved Table view is kept while other views exist. Deleting the only
 * view is fine: the table falls back to its implicit Table tab.
 */
export function canDeleteView(
  subject: string,
  typesBySubject: ReadonlyMap<string, string>,
): boolean {
  if (typesBySubject.get(subject) !== 'table') return true;
  if (typesBySubject.size <= 1) return true;

  return canChangeViewType(subject, typesBySubject);
}

/** View names the templates ship, e.g. "All issues", "Board", "Schedule". */
const TEMPLATE_VIEW_NAMES: ReadonlySet<string> = new Set(
  TABLE_TEMPLATES.flatMap(t => t.spec?.views ?? []).map(v =>
    v.name.trim().toLowerCase(),
  ),
);

const GENERIC_VIEW_NAMES: ReadonlySet<string> = new Set(
  [
    'Default View',
    'Untitled view',
    'View',
    ...VIEW_KINDS.map(k => VIEW_KIND_LABELS[k]),
  ].map(n => n.toLowerCase()),
);

/**
 * Whether `name` is one the view was given rather than one a person chose, so
 * it describes the view's old type and would mislead once the type changes.
 *
 * That is: empty, the generic "Default View", a type's own label ("Table",
 * "Kanban", …), the app's name, a template's view name — or, for a table
 * view, the "All <rows>" shape templates and the assistant give the table
 * that lists every row ("All pieces"). On a calendar that name is wrong.
 */
export function isDefaultViewName(
  name: string | undefined,
  typeKey: string,
  appName?: string,
): boolean {
  const n = (name ?? '').trim().toLowerCase();

  if (!n) return true;
  if (GENERIC_VIEW_NAMES.has(n) || TEMPLATE_VIEW_NAMES.has(n)) return true;
  if (appName && n === appName.trim().toLowerCase()) return true;

  return typeKey === 'table' && /^all\s/.test(n);
}

/**
 * The name a view should carry after changing from `fromType` to a type
 * labelled `toLabel`: the new label when the old name was a default, and
 * `undefined` (keep it) when a person named the view themselves.
 */
export function nameAfterTypeChange(
  name: string | undefined,
  fromType: string,
  toLabel: string,
  fromAppName?: string,
): string | undefined {
  return isDefaultViewName(name, fromType, fromAppName) ? toLabel : undefined;
}
