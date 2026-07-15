import { isMobileTauri, isRunningInTauri } from './tauri';

/** Mirrors the Rust `VfsStatus` returned by the desktop virtual-drive commands. */
export interface VirtualDriveStatus {
  /** The NFS server is listening. */
  running: boolean;
  /** The drive is mounted into the filesystem. */
  mounted: boolean;
  /** Where it is mounted (e.g. `~/AtomicDrive`), when mounted. */
  mount_path: string | null;
}

/**
 * The virtual drive is a desktop-only Tauri feature: it runs a local NFS server
 * and mounts it into the filesystem. Mobile can't mount NFS (it uses provider
 * APIs), and the browser has no local node — so the settings UI is shown only
 * when this is true.
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

/** Start the NFS server and mount the drive. Rejects with a message on failure. */
export const startVirtualDrive = (): Promise<VirtualDriveStatus> =>
  invokeVirtualDrive('virtual_drive_start');

/** Unmount the drive and stop the server. */
export const stopVirtualDrive = (): Promise<VirtualDriveStatus> =>
  invokeVirtualDrive('virtual_drive_stop');

/** Open the mounted folder in the OS file manager. */
export async function openVirtualDrive(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('virtual_drive_open');
}
