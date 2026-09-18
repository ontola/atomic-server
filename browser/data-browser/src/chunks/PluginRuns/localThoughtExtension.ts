import { googleCalendarIntegration } from '@localthought/atomic-integrations/ui/GoogleCalendar';
import type { ComponentType } from 'react';
import type { Config } from '../../../../../integrations/localthought/plugin';
import type { FetchedPlatform } from '../../../../../integrations/localthought/schema';
import {
  TODOIST_PLATFORM,
  todoistFields,
  todoistProjection,
} from '../../../../../integrations/localthought/todoist';

/**
 * How a LocalThought installation was set up. `none` is the plain generated
 * import; the others name the Devonian lens that translates the provider's
 * records on their way in (and, for Calendar, back out). Stored on the
 * installation, so a lens added later never changes what an older folder
 * shows.
 */
export type LocalThoughtExtensionMode = 'calendar' | 'tasks' | 'none';

/**
 * A platform-specific translation on top of the generic LocalThought import:
 * what to ask the provider for, how to project what comes back, and which
 * view to open the projected table in. `googleCalendarIntegration` is the
 * reference shape; the fields it has that this type leaves optional are the
 * ones only a writable lens needs.
 */
export interface LocalThoughtExtension<Selection = unknown> {
  /** The LocalThought platform id this lens is for. */
  id: string;
  label: string;
  /** Recorded on the installation; also the identity suffix `:devonian-<mode>`. */
  mode: Exclude<LocalThoughtExtensionMode, 'none'>;
  defaultConstants: Record<string, string>;
  defaultSelection(): Selection | undefined;
  /** Turns the setup dialog's selection into provider query overrides. */
  selection(value: Selection): FetchedPlatformSelection | undefined;
  identitySuffix(value: Selection): string;
  /** The Devonian lens: projects fetched records into local columns. */
  project(fetched: FetchedPlatform): FetchedPlatform;
  /** The projected view added beside the plain table for this class. */
  view: {
    classShortname: string;
    groupByShortname: string;
    /** Which renderer. Missing is `calendar`, the first lens's only option. */
    kind?: 'calendar' | 'issues';
  };
  ImportControls?: ComponentType<{
    value: Selection;
    disabled: boolean;
    onChange(value: Selection): void;
  }>;
  /** Present only for a lens with a write direction. */
  Sync?: ComponentType<{
    disabled: boolean;
    config: Config;
    rows(): Promise<Map<string, Record<string, unknown>>>;
    request(
      path: string,
      init?: { method?: string; body?: string; ifMatch?: string },
    ): Promise<{ status: number; body: string }>;
    checkpoint(subject: string, values: Record<string, unknown>): Promise<void>;
  }>;
}

type FetchedPlatformSelection = {
  query_overrides: { path: string; values: Record<string, unknown> }[];
};

/**
 * Todoist, read only: the proxy's catalog only grants `data:read`, so this
 * lens projects tasks into an issue list (title from `content`, closed from
 * `checked`, a due day for the calendar) and has no Sync panel.
 */
export const todoistIntegration: LocalThoughtExtension = {
  id: TODOIST_PLATFORM,
  label: 'Todoist',
  mode: 'tasks',
  defaultConstants: {},
  defaultSelection: () => undefined,
  selection: () => undefined,
  identitySuffix: () => '',
  project: todoistProjection,
  view: {
    classShortname: 'task',
    groupByShortname: todoistFields.done,
    kind: 'issues',
  },
};

const calendarIntegration: LocalThoughtExtension<
  ReturnType<typeof googleCalendarIntegration.defaultSelection>
> = {
  ...googleCalendarIntegration,
  mode: 'calendar',
  view: { ...googleCalendarIntegration.view, kind: 'calendar' },
};

// Consumers forget each lens's selection type: the setup dialog only ever
// hands a selection back to the lens that produced it.
export const googleCalendarLens = calendarIntegration as LocalThoughtExtension;

const EXTENSIONS: LocalThoughtExtension[] = [
  googleCalendarLens,
  todoistIntegration,
];

/** Missing mode is a pre-category installation, when Calendar was always Devonian. */
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
