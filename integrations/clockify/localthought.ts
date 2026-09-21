// @wc-ignore-file
/**
 * Clockify as a LocalThought extension: no AtomicServer-side code, no stored
 * secret. The personal API key is sealed by the integration proxy, the generic
 * Syncables engine pages through `timeEntries`, and this module only shapes
 * the result into a Time Tracker table: a start/end interval per completed
 * entry, running timers and breaks left out, and a rolling look-back window.
 */
import { Datatype } from "../../browser/lib/src/index.js";
import type { JSONValue } from "../../browser/lib/src/value.js";
import type {
  FetchedPlatform,
  FetchedRecord,
  Term,
} from "../localthought/schema.js";

export const CLOCKIFY_PLATFORM = "clockify";
export const CLOCKIFY_APP = "https://app.clockify.me";
export const TIME_ENTRIES_PATH =
  "/v1/workspaces/{workspaceId}/user/{userId}/time-entries";
/** Term shortnames the projection adds next to the provider's own fields. */
export const clockifyFields = {
  start: "start",
  end: "end",
} as const;
export const LOOKBACK_OPTIONS = [7, 30] as const;
export type LookbackDays = (typeof LOOKBACK_OPTIONS)[number];

export interface ClockifySelection {
  lookbackDays: LookbackDays;
}
export const defaultClockifySelection = (): ClockifySelection => ({
  lookbackDays: 7,
});

/** Clockify wants `yyyy-MM-ddThh:mm:ssZ`; drop the milliseconds. */
const clockifyInstant = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Query overrides for one refresh. Computed at each run, never stored, so the
 * window rolls with the clock instead of freezing at installation.
 */
export function clockifyImportQuery(
  selection: ClockifySelection,
  now = Date.now(),
) {
  if (!LOOKBACK_OPTIONS.includes(selection.lookbackDays))
    throw new Error("Clockify look-back must be 7 or 30 days");
  const start = now - selection.lookbackDays * 86_400_000;

  return {
    query_overrides: [
      {
        path: TIME_ENTRIES_PATH,
        values: {
          start: clockifyInstant(start),
          end: clockifyInstant(now),
          "page-size": 50,
        },
      },
    ],
  };
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const instant = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * Adds a typed start/end interval to every completed `timeentry` and names
 * it after its description. Entries still running (no end) and breaks are
 * skipped: the Time Tracker's own timer owns anything without an end, and a
 * break is not work. Provider fields stay on the record untouched.
 */
export function clockifyProjection(fetched: FetchedPlatform): FetchedPlatform {
  if (fetched.platform !== CLOCKIFY_PLATFORM) return fetched;
  const entry = fetched.ontology.terms.find(
    (t) => t.kind === "class" && t.shortname === "timeentry",
  );
  if (!entry) return fetched;
  const definitions: [string, string][] = [
    [clockifyFields.start, "Start instant of the entry, from Clockify's UTC interval."],
    [clockifyFields.end, "End instant of the completed entry, from Clockify's UTC interval."],
  ];
  const terms: Term[] = definitions.map(([shortname, description]) => ({
    path: `urn:atomic:clockify:${shortname}`,
    kind: "property",
    shortname,
    datatype: Datatype.TIMESTAMP,
    description,
    requires: [],
    recommends: [],
  }));
  if (
    fetched.ontology.terms.some((t) =>
      terms.some((extra) => extra.shortname === t.shortname),
    )
  )
    throw new Error("Clockify projection property collides with provider ontology");
  const records: FetchedRecord[] = [];

  for (const row of fetched.records) {
    if (row.resource !== "timeentry") {
      records.push(row);
      continue;
    }

    if (row.values.type === "BREAK") continue;
    const interval = object(row.values.timeinterval);
    const start = instant(interval.start);
    const end = instant(interval.end);
    if (start === undefined)
      throw new Error(`Clockify entry ${row.id} has no valid start`);
    if (end === undefined) continue;
    if (end < start)
      throw new Error(`Clockify entry ${row.id} ends before it starts`);
    const description =
      typeof row.values.description === "string"
        ? row.values.description.trim()
        : "";
    const values: Record<string, JSONValue> = {
      ...row.values,
      [clockifyFields.start]: start,
      [clockifyFields.end]: end,
    };
    records.push({
      ...row,
      name: description || "Time entry",
      values,
    });
  }

  return {
    ...fetched,
    ontology: {
      ...fetched.ontology,
      terms: [
        ...fetched.ontology.terms.map((t) =>
          t === entry
            ? {
                ...t,
                recommends: [...t.recommends, ...terms.map((extra) => extra.path)],
              }
            : t,
        ),
        ...terms,
      ],
    },
    records,
  };
}
