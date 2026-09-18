import type { ComponentType } from 'react';
import { googleCalendarIntegration } from '@localthought/atomic-integrations/ui/GoogleCalendar';
import type { FetchedPlatform } from '../../../../../integrations/localthought/schema';
import type { TableViewSpec } from '@chunks/TablePage/createTableFromSpec';
import { clockifyIntegration } from './ClockifyLocalThought';

/** Missing mode is a pre-category installation, when Calendar was always Devonian. */
export type LocalThoughtExtensionMode = 'calendar' | 'clockify' | 'none';

export interface QuerySelection {
  query_overrides: { path: string; values: Record<string, unknown> }[];
}

/**
 * A platform-specific lens over the generic LocalThought flow. Everything is
 * optional except identity: an extension can shape the fetched records
 * (`project`), narrow the fetch (`selection`), add setup controls, define the
 * views its table opens with, and offer a sync panel on the installed folder.
 */
// The registry erases the selection type: each lens is only ever handed the
// value its own `defaultSelection` produced.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface LocalThoughtExtension<Selection = any> {
  id: string;
  label: string;
  /** Which `LocalThoughtInstallation.extension` value selects this lens. */
  mode: Exclude<LocalThoughtExtensionMode, 'none'>;
  /** Appended to the installation identity so modes never share a folder. */
  identityPrefix: string;
  defaultConstants?: Record<string, string>;
  defaultSelection(): Selection;
  /** Query overrides for one fetch. Called on every refresh, so it may roll. */
  selection(value: Selection): QuerySelection;
  identitySuffix(value: Selection): string;
  project(value: FetchedPlatform): FetchedPlatform;
  /** A calendar view next to the generic table (the Devonian calendar lens). */
  view?: { classShortname: string; groupByShortname: string };
  /** Views that replace the generic table view, by class shortname. Column
   * references are term shortnames (or `name`). The first one is the default. */
  views?: Record<string, TableViewSpec[]>;
  ImportControls?: ComponentType<{
    value: Selection;
    disabled: boolean;
    onChange(value: Selection): void;
  }>;
  Sync?: typeof googleCalendarIntegration.Sync;
}

const calendar: LocalThoughtExtension<
  ReturnType<typeof googleCalendarIntegration.defaultSelection>
> = {
  ...googleCalendarIntegration,
  mode: 'calendar',
  identityPrefix: ':devonian-calendar',
};

const EXTENSIONS: LocalThoughtExtension[] = [calendar, clockifyIntegration];

export function extensionMode(
  platform: string,
  mode: LocalThoughtExtensionMode | undefined,
): LocalThoughtExtensionMode {
  return (
    mode ?? (platform === googleCalendarIntegration.id ? 'calendar' : 'none')
  );
}

export function localThoughtExtension(
  platform: string,
  mode: LocalThoughtExtensionMode | undefined,
): LocalThoughtExtension | undefined {
  const resolved = extensionMode(platform, mode);

  return EXTENSIONS.find(
    extension => extension.mode === resolved && extension.id === platform,
  );
}

/** Provider transport remains stable; only local schema terms are mode-scoped. */
export function schemaNamespace(
  platform: string,
  mode: LocalThoughtExtensionMode | undefined,
) {
  return mode === 'none' ? `api-${platform}` : platform;
}
