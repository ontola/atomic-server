export interface DriveApp {
  subject: string;
  name: string;
  /** The row classes this app can show. */
  renders: string[];
  /** Classes supported as individual resource pages. */
  resourceRenders?: string[];
}

export interface DriveApps {
  apps: DriveApp[];
  /** Host-provided discovery for executable Syncables collection views. */
  collectionView?: { applicable: boolean; refresh: () => void };
  /**
   * Ask again. Call it when a menu that lists the apps opens, so opening it
   * always reflects what the drive holds now.
   */
  refresh: () => void;
}

/**
 * The apps that can show rows of `rowClass`.
 *
 * An app declares what it handles, and is offered nowhere else. Listing every
 * app on every table would mean a calendar app offered for a table of
 * invoices — and with fifty apps on a drive, a menu nobody can read.
 *
 * Pure, so the rule can be read and tested without a store.
 */
export function appsForClass(
  apps: DriveApp[],
  rowClass: string | undefined,
): DriveApp[] {
  if (!rowClass) return [];

  return apps.filter(app => app.renders.includes(rowClass));
}
