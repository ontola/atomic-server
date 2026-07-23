import type { IconType } from 'react-icons';
import { FaTable, FaTableColumns, FaCalendarDays } from 'react-icons/fa6';

/**
 * The `view-kind` string stored on a View resource decides which renderer
 * displays the table's rows. Stored as a plain string in the ontology so new
 * kinds can be added without a schema migration; this union is the frontend's
 * source of truth for the ones we actually render.
 */
export const VIEW_KINDS = ['table', 'kanban', 'calendar'] as const;

export type ViewKind = (typeof VIEW_KINDS)[number];

export const DEFAULT_VIEW_KIND: ViewKind = 'table';

/** Narrows an arbitrary stored string to a known ViewKind, falling back to table. */
export function normalizeViewKind(kind: string | undefined): ViewKind {
  return (VIEW_KINDS as readonly string[]).includes(kind ?? '')
    ? (kind as ViewKind)
    : DEFAULT_VIEW_KIND;
}

export const VIEW_KIND_LABELS: Record<ViewKind, string> = {
  table: 'Table',
  kanban: 'Kanban',
  calendar: 'Calendar',
};

export const VIEW_KIND_ICONS: Record<ViewKind, IconType> = {
  table: FaTable,
  kanban: FaTableColumns,
  calendar: FaCalendarDays,
};
