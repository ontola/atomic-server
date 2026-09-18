// @wc-ignore-file
import { Datatype } from "../../browser/lib/src/index.js";
import type { JSONValue } from "../../browser/lib/src/value.js";
import type { FetchedPlatform, FetchedRecord, Term } from "./schema.js";

/**
 * Todoist's task shape, as the integration proxy's read-only catalog exposes
 * it, translated onto what an issue list needs. An additional projection,
 * never a replacement for the provider's fields: `content`, `checked`, `due`
 * and the rest stay on the row, these columns sit beside them.
 *
 * The proxy's Todoist catalog is `data:read` only, so this lens has no
 * write direction: nothing an issue list changes here is sent back.
 */
export const todoistFields = {
  /** Whether Todoist has this task checked off. The issue list's closed flag. */
  done: "done",
  /** The due day, from `due.date` (or the day of `due.datetime`). */
  dueDay: "due-day",
  /** Todoist's 1 (normal) to 4 (urgent) priority, as a label. */
  priorityLabel: "priority-label",
} as const;

export const TODOIST_PLATFORM = "todoist";

const PRIORITY_LABELS: Record<number, string> = {
  1: "Normal",
  2: "Medium",
  3: "High",
  4: "Urgent",
};

const DAY = /^\d{4}-\d{2}-\d{2}/;

export function todoistProjection(fetched: FetchedPlatform): FetchedPlatform {
  if (fetched.platform !== TODOIST_PLATFORM) return fetched;
  const task = fetched.ontology.terms.find((t) => t.kind === "class" && t.shortname === "task");
  if (!task) return fetched;
  const definitions: [string, Datatype, string][] = [
    [todoistFields.done, Datatype.BOOLEAN, "Whether the task is completed in Todoist."],
    [todoistFields.dueDay, Datatype.DATE, "The day the task is due, from Todoist's due date or time."],
    [todoistFields.priorityLabel, Datatype.STRING, "Todoist priority: Normal, Medium, High or Urgent."],
  ];
  const terms: Term[] = definitions.map(([shortname, datatype, description]) => ({
    path: `urn:atomic:todoist:${shortname}`,
    kind: "property",
    shortname,
    datatype,
    description,
    requires: [],
    recommends: [],
  }));
  if (fetched.ontology.terms.some((t) => terms.some((extra) => extra.shortname === t.shortname)))
    throw new Error("Todoist projection property collides with provider ontology");

  return {
    ...fetched,
    ontology: {
      ...fetched.ontology,
      terms: [
        ...fetched.ontology.terms.map((t) =>
          t === task ? { ...t, recommends: [...t.recommends, ...terms.map((extra) => extra.path)] } : t,
        ),
        ...terms,
      ],
    },
    records: fetched.records.map(projectRecord),
  };
}

function projectRecord(row: FetchedRecord): FetchedRecord {
  if (row.resource !== "task") return row;
  const values: Record<string, JSONValue> = {
    ...row.values,
    [todoistFields.done]: row.values.checked === true,
  };
  const due = object(row.values.due);
  const dueDate = typeof due.date === "string" ? due.date : due.datetime;
  if (typeof dueDate === "string" && DAY.test(dueDate)) values[todoistFields.dueDay] = dueDate.slice(0, 10);
  const label = typeof row.values.priority === "number" ? PRIORITY_LABELS[row.values.priority] : undefined;
  if (label) values[todoistFields.priorityLabel] = label;

  // Syncables names a record after `title`, `summary` or `name`; a Todoist
  // task has none of those, its text is `content`. Without this the issue list
  // would show every task as its id.
  const content = typeof row.values.content === "string" ? row.values.content.trim() : "";

  return { ...row, name: content || row.name, values };
}

function object(value: JSONValue | undefined): Record<string, JSONValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
