// Kept free of app component imports on purpose: the sync module loads this
// lens outside React, and pulling in the form kit drags the whole app along.
import { styled } from 'styled-components';
import {
  CLOCKIFY_APP,
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
import type { LocalThoughtInstallation, SyncRun } from './localThoughtSync';

const isLookback = (value: unknown): value is LookbackDays =>
  LOOKBACK_OPTIONS.includes(value as LookbackDays);

function LookbackSelect({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: LookbackDays;
  disabled: boolean;
  onChange(value: LookbackDays): void;
}) {
  return (
    <select
      id={id}
      value={String(value)}
      disabled={disabled}
      onChange={e => {
        const days = Number(e.target.value);
        if (isLookback(days)) onChange(days);
      }}
    >
      {LOOKBACK_OPTIONS.map(days => (
        <option key={days} value={days}>
          {`Past ${days} days`}
        </option>
      ))}
    </select>
  );
}

/**
 * Two-way sync is on the roadmap but LocalThought never writes to Clockify
 * today, so the choice is shown the way the design has it and locked to
 * import-only rather than hidden: the user sees what is coming.
 */
function Direction() {
  return (
    <Fieldset>
      <legend>Direction</legend>
      <Option>
        <input type='radio' name='clockify-direction' checked readOnly />
        <span>
          <strong>Import only</strong>
          <small>
            Clockify is the source of truth. Entries here update when Clockify
            changes; local edits are kept but never sent back.
          </small>
        </span>
      </Option>
      <Option aria-disabled>
        <input type='radio' name='clockify-direction' disabled />
        <span>
          <strong>
            Two-way sync <Soon>Coming soon</Soon>
          </strong>
          <small>
            Timers you start and edits you make here would be pushed to Clockify
            on each run, with conflicts shown for review.
          </small>
        </span>
      </Option>
    </Fieldset>
  );
}

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
    <>
      <Field>
        <label htmlFor='clockify-lookback'>Entries from</label>
        <LookbackSelect
          id='clockify-lookback'
          value={value.lookbackDays}
          disabled={disabled}
          onChange={lookbackDays => onChange({ ...value, lookbackDays })}
        />
      </Field>
      <Direction />
      <small>
        Description, start/end and billable are synced. Tags, tasks, hourly
        rates and custom fields are not. The table refreshes while it is open.
      </small>
    </>
  );
}

const MAPPING: [string, string][] = [
  ['Description', 'Name'],
  ['Start · End', 'Start · End (Duration derived)'],
  ['Billable', 'Billable'],
  ['Project · Task', 'Not mapped (raw ids kept on the row)'],
  ['Tags · Hourly rate · Custom fields', 'Not mapped'],
];

const runLabel = (run: SyncRun) =>
  run.error
    ? `Failed: ${run.error}`
    : run.applied
      ? `${run.fetched ?? 0} pulled · ${run.applied} changed`
      : run.fetched
        ? `${run.fetched} pulled · no changes`
        : 'No entries in range';

/** The Manage screen: status, settings, mapping, connection, recent runs. */
export function ClockifyManage({
  installation,
  disabled,
  update,
}: {
  installation: LocalThoughtInstallation;
  disabled: boolean;
  update(patch: Partial<LocalThoughtInstallation>): void;
}) {
  const selection = installation.selectionValue as
    | ClockifySelection
    | undefined;
  const lookback = selection?.lookbackDays ?? 7;
  const status = installation.syncing
    ? 'Syncing…'
    : installation.error
      ? 'Needs attention'
      : installation.lastSuccess
        ? 'Up to date'
        : 'Waiting for first sync';
  const workspace =
    installation.labels?.workspaceId ?? installation.constants.workspaceId;
  const account = installation.labels?.userId ?? installation.constants.userId;

  return (
    <Manage aria-label='Clockify sync'>
      <Tiles>
        <Tile>
          <small>Status</small>
          <strong>{status}</strong>
          <small>
            {installation.lastSuccess
              ? `Last run ${new Date(installation.lastSuccess).toLocaleString()}`
              : 'Runs when this table is open'}
          </small>
        </Tile>
        <Tile aria-disabled>
          <small>Waiting to push</small>
          <strong>—</strong>
          <small>Needs two-way sync</small>
        </Tile>
        <Tile aria-disabled>
          <small>Conflicts</small>
          <strong>—</strong>
          <small>Needs two-way sync</small>
        </Tile>
      </Tiles>

      <Section>
        <h3>Settings</h3>
        <Direction />
        <Field>
          <label htmlFor='clockify-schedule'>Schedule</label>
          <select id='clockify-schedule' value='open' disabled>
            <option value='open'>
              Every 5 minutes while this table is open
            </option>
            <option value='hour'>Every hour (coming soon)</option>
            <option value='day'>Daily (coming soon)</option>
          </select>
          <small>
            Closed tabs do not run schedules. Use Sync now for an immediate
            refresh.
          </small>
        </Field>
        <Field>
          <label htmlFor='clockify-manage-lookback'>Look back</label>
          <LookbackSelect
            id='clockify-manage-lookback'
            value={lookback}
            disabled={disabled}
            onChange={lookbackDays =>
              update({ selectionValue: { ...selection, lookbackDays } })
            }
          />
          <small>
            Applies from the next run. Entries already imported stay.
          </small>
        </Field>
      </Section>

      <Section>
        <h3>Field mapping</h3>
        <Mapping>
          <tbody>
            {MAPPING.map(([from, to]) => (
              <tr key={from}>
                <td>{from}</td>
                <td>→ {to}</td>
                <td>{to.startsWith('Not mapped') ? '—' : 'Import'}</td>
              </tr>
            ))}
          </tbody>
        </Mapping>
      </Section>

      <Section>
        <h3>Connection</h3>
        <p>
          <strong>{account}</strong> · Workspace {workspace} · api.clockify.me
        </p>
        <small>
          Personal API key sealed by LocalThought for this browser. Used for
          reading your entries only. Reconnect from the Integrations page to
          replace the key.
        </small>
      </Section>

      <Section>
        <h3>Recent runs</h3>
        {installation.runs?.length ? (
          <Runs>
            {installation.runs.map(run => (
              <li key={run.at}>
                <time dateTime={new Date(run.at).toISOString()}>
                  {new Date(run.at).toLocaleString()}
                </time>{' '}
                {runLabel(run)}
              </li>
            ))}
          </Runs>
        ) : (
          <small>No runs yet.</small>
        )}
      </Section>
    </Manage>
  );
}

const clockifyLens: LocalThoughtExtension<ClockifySelection> = {
  id: CLOCKIFY_PLATFORM,
  label: 'Clockify',
  mode: 'clockify',
  defaultConstants: {},
  defaultSelection: defaultClockifySelection,
  selection: clockifyImportQuery,
  identitySuffix: () => '',
  project: clockifyProjection,
  // The Time Tracker template's views over Clockify's projected fields, so an
  // import lands in the same timer the built-in template offers: a Timer view
  // with a derived Duration and per-day totals, and a plain list.
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
  steps: ['API key', 'Choose what to sync', 'Import'],
  connectionNote: 'Connected · key sealed by LocalThought, read access only',
  ImportControls: ClockifyImportControls,
  providerLink: () => ({
    href: `${CLOCKIFY_APP}/tracker`,
    label: 'Open in Clockify',
  }),
  Manage: ClockifyManage,
};

// Consumers forget the selection type, as with the other lenses: the setup
// dialog only hands back what `defaultSelection` produced.
export const clockifyIntegration = clockifyLens as LocalThoughtExtension;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;

  label {
    font-weight: 600;
    font-size: 0.85rem;
  }

  select {
    padding: 0.4rem 0.6rem;
    border: 1px solid ${p => p.theme.colors.bg2};
    border-radius: ${p => p.theme.radius};
    background: ${p => p.theme.colors.bg};
    color: ${p => p.theme.colors.text};
    max-width: 24rem;
  }

  small {
    color: ${p => p.theme.colors.textLight};
  }
`;

const Fieldset = styled.fieldset`
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;

  legend {
    font-weight: 600;
    font-size: 0.85rem;
    margin-bottom: 0.5rem;
  }
`;

const Option = styled.label`
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};

  &[aria-disabled] {
    opacity: 0.6;
  }

  input {
    margin-top: 0.2rem;
  }

  span {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  small {
    color: ${p => p.theme.colors.textLight};
  }
`;

const Soon = styled.span`
  display: inline;
  margin-left: 0.5rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  background: ${p => p.theme.colors.bg2};
  color: ${p => p.theme.colors.textLight};
`;

const Manage = styled.section`
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
`;

const Tiles = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.75rem;
`;

const Tile = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.75rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};

  &[aria-disabled] {
    opacity: 0.6;
  }

  small {
    color: ${p => p.theme.colors.textLight};
  }
`;

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;

  h3 {
    margin: 0;
    font-size: 1rem;
  }

  p {
    margin: 0;
  }

  small {
    color: ${p => p.theme.colors.textLight};
  }
`;

const Mapping = styled.table`
  border-collapse: collapse;
  font-size: 0.9rem;

  td {
    padding: 0.3rem 0.75rem 0.3rem 0;
    border-bottom: 1px solid ${p => p.theme.colors.bg2};
    vertical-align: top;
  }

  td:last-child {
    color: ${p => p.theme.colors.textLight};
  }
`;

const Runs = styled.ul`
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.9rem;

  time {
    color: ${p => p.theme.colors.textLight};
  }
`;
