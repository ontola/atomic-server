// Kept free of app component imports on purpose: the sync module loads this
// lens outside React, and pulling in the form kit drags the whole app along.
import {
  CLOCKIFY_PLATFORM,
  clockifyFields,
  clockifyImportQuery,
  clockifyProjection,
  defaultClockifySelection,
  LOOKBACK_OPTIONS,
  type ClockifySelection,
  type LookbackDays,
} from '../../../../../integrations/clockify/localthought';
import type { LocalThoughtExtension } from './localThoughtExtension';

export function ClockifyImportControls({
  value,
  disabled,
  onChange,
}: {
  value: ClockifySelection;
  disabled: boolean;
  onChange(value: ClockifySelection): void;
}) {
  return (
    <label>
      Entries from{' '}
      <select
        value={String(value.lookbackDays)}
        disabled={disabled}
        onChange={e =>
          onChange({
            ...value,
            lookbackDays: Number(e.target.value) as LookbackDays,
          })
        }
      >
        {LOOKBACK_OPTIONS.map(days => (
          <option key={days} value={days}>
            Past {days} days
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The Time Tracker template's views over Clockify's projected fields, so an
 * import lands in the same timer the built-in template offers: a Timer view
 * with a derived Duration and per-day totals, and a plain list.
 */
export const clockifyIntegration: LocalThoughtExtension<ClockifySelection> = {
  id: CLOCKIFY_PLATFORM,
  label: 'Clockify',
  mode: 'clockify',
  identityPrefix: ':clockify',
  defaultSelection: defaultClockifySelection,
  selection: clockifyImportQuery,
  identitySuffix: () => '',
  project: clockifyProjection,
  views: {
    timeentry: [
      {
        name: 'Timer',
        kind: 'timer',
        groupByColumn: clockifyFields.start,
        endColumn: clockifyFields.end,
        derivedColumns: [
          {
            name: 'Duration',
            kind: 'elapsed',
            args: { from: clockifyFields.start, until: clockifyFields.end },
          },
        ],
        aggregates: [{ function: 'sum', computedColumn: 'Duration' }],
        breakdownColumn: clockifyFields.start,
        breakdownGranularity: 'day',
        sortByColumn: clockifyFields.start,
        sortDesc: true,
        columns: ['name', clockifyFields.start, clockifyFields.end, 'billable'],
        default: true,
      },
      {
        name: 'All entries',
        kind: 'table',
        sortByColumn: clockifyFields.start,
        sortDesc: true,
      },
    ],
  },
  ImportControls: ClockifyImportControls,
};
