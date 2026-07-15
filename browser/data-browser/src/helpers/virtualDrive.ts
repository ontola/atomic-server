import { isMobileTauri, isRunningInTauri } from './tauri';

/** Mirrors the Rust `VfsStatus` returned by the desktop virtual-drive commands. */
export interface VirtualDriveStatus {
  running: boolean;
  addr: string;
  /** The `mount` command a user runs to attach the drive. */
  mount_command: string;
}

/**
 * The virtual drive is a desktop-only Tauri feature: it runs a local NFS server
 * the OS mounts. Mobile can't mount NFS (it uses provider APIs), and the browser
 * has no local node — so the settings UI is shown only when this is true.
 */
export const isVirtualDriveAvailable = (): boolean =>
  isRunningInTauri() && !isMobileTauri();

async function invokeVirtualDrive(
  command:
    | 'virtual_drive_status'
    | 'virtual_drive_start'
    | 'virtual_drive_stop',
): Promise<VirtualDriveStatus> {
  const { invoke } = await import('@tauri-apps/api/core');

  return invoke<VirtualDriveStatus>(command);
}

export const getVirtualDriveStatus = (): Promise<VirtualDriveStatus> =>
  invokeVirtualDrive('virtual_drive_status');

export const startVirtualDrive = (): Promise<VirtualDriveStatus> =>
  invokeVirtualDrive('virtual_drive_start');

export const stopVirtualDrive = (): Promise<VirtualDriveStatus> =>
  invokeVirtualDrive('virtual_drive_stop');
