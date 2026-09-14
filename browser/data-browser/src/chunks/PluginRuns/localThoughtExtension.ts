import { googleCalendarIntegration } from '@localthought/atomic-integrations/ui/GoogleCalendar';

export type LocalThoughtExtensionMode = 'calendar' | 'none';

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
) {
  return extensionMode(platform, mode) === 'calendar' &&
    platform === googleCalendarIntegration.id
    ? googleCalendarIntegration
    : undefined;
}

/** Provider transport remains stable; only local schema terms are mode-scoped. */
export function schemaNamespace(
  platform: string,
  mode: LocalThoughtExtensionMode | undefined,
) {
  return mode === 'none' ? `api-${platform}` : platform;
}
