// @wc-ignore-file
export const TEMPLATE_DEMO_KEY = 'atomic.templateDemo';
export interface TemplateDemo {
  drive: string;
  template: string;
  previousDrive: string;
}
export function readTemplateDemo(): TemplateDemo | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(TEMPLATE_DEMO_KEY) ?? 'null');
    if (
      value &&
      typeof value.drive === 'string' &&
      typeof value.template === 'string' &&
      typeof value.previousDrive === 'string'
    )
      return value;
  } catch {
    /* Storage is unavailable or a previous version wrote invalid data. */
  }
}

/** The interactive demo's manifest, reduced to what the chrome needs. The
 *  full manifest lives in the demo chunk; reading these two fields here keeps
 *  that chunk out of the main bundle. */
export function readInteractiveDemo():
  | { drive: string; welcomeDoc: string }
  | undefined {
  try {
    const value = JSON.parse(
      localStorage.getItem('atomic.demoWorkspace') ?? 'null',
    );
    if (
      value &&
      typeof value.drive === 'string' &&
      typeof value.welcomeDoc === 'string'
    )
      return { drive: value.drive, welcomeDoc: value.welcomeDoc };
  } catch {
    /* Storage is unavailable or a previous version wrote invalid data. */
  }
}

export type ActiveDemo =
  | { kind: 'template'; session: TemplateDemo }
  | { kind: 'interactive'; drive: string; welcomeDoc: string };

/**
 * The demo `drive` belongs to, if any. "In a demo" means exactly this: the
 * current drive is one of the two demo drives. Each record is matched on its
 * own, so a stale record of one kind (a template preview left behind by a
 * closed tab) can never hide the bar of the other.
 */
export function demoForDrive(
  drive: string | undefined,
): ActiveDemo | undefined {
  if (!drive) return undefined;
  const template = readTemplateDemo();
  if (template?.drive === drive) return { kind: 'template', session: template };
  const interactive = readInteractiveDemo();
  if (interactive?.drive === drive)
    return { kind: 'interactive', ...interactive };

  return undefined;
}
