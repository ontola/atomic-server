/** What the web app needs to know about a `ConnectedApp` resource. */
export interface ConnectedAppInfo {
  subject: string;
  name: string;
  homepage?: string;
  /** A URL with `{subject}` where the URL-encoded resource subject goes. */
  openUrlTemplate?: string;
  handlesClasses: string[];
}

/** The URL that opens `subject` in an app, or undefined for an unusable template. */
export function buildOpenUrl(
  template: string,
  subject: string,
): string | undefined {
  if (!template.includes('{subject}')) {
    return undefined;
  }

  const url = template.replaceAll('{subject}', encodeURIComponent(subject));

  try {
    const parsed = new URL(url);

    // The template comes from the drive, which other people can write to.
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export interface OpenInApp {
  app: ConnectedAppInfo;
  url: string;
}

/**
 * The apps that can open a resource with these classes: those whose
 * `handlesClasses` overlap `resourceClasses` and whose template is usable.
 */
export function appsForResource(
  apps: ConnectedAppInfo[],
  resourceClasses: string[],
  subject: string,
): OpenInApp[] {
  const result: OpenInApp[] = [];

  for (const app of apps) {
    if (!app.openUrlTemplate) continue;
    if (!app.handlesClasses.some(c => resourceClasses.includes(c))) continue;

    const url = buildOpenUrl(app.openUrlTemplate, subject);

    if (url) result.push({ app, url });
  }

  return result;
}
