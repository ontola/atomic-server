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
