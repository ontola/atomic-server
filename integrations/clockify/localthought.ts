// @wc-ignore-file
/**
 * Clockify as a LocalThought extension: no AtomicServer-side code, no stored
 * secret. The personal API key is sealed by the integration proxy, the generic
 * Syncables engine pages through `timeEntries`, and this module only builds
 * the query window and re-exports the platform lens (schema translation, in
 * devonian/platform-lenses/clockify -- localthought/atomic-plugins#4) that
 * shapes the result into a Time Tracker table: a start/end interval per
 * completed entry, running timers and breaks left out.
 */
export {
  CLOCKIFY_PLATFORM,
  clockifyFields,
  clockifyProjection,
  resolveClockifyReferences,
  type ClockifyReferenceResolution,
  type FetchedPlatform,
  type FetchedRecord,
  type Term,
} from "devonian/platform-lenses/clockify";

export const CLOCKIFY_APP = "https://app.clockify.me";
export const TIME_ENTRIES_PATH =
  "/v1/workspaces/{workspaceId}/user/{userId}/time-entries";
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
