export function syncSummary(input: {
  missing: boolean;
  local: boolean;
  serverSync: boolean;
  hosting: boolean | null;
  managed: boolean;
  vaultOn: boolean;
}): string {
  if (input.missing)
    return 'This workspace could not be loaded. Its sync and backup status are unknown.';
  if (input.managed && input.serverSync && input.hosting === false)
    return 'This drive is still syncing with a server, but Cloud Server hosting has not been confirmed.';
  if (!input.local) return 'Your data lives on the device you’re connected to.';
  if (input.vaultOn)
    return 'Your data lives on this device. Cloud Vault is on; browser sync connects your open devices.';
  if (input.serverSync)
    return 'Your data lives on this device and syncs with a server.';

  return 'Your data lives on this device. Browser sync connects when another browser is available.';
}

export function showSavedServer(input: {
  managed: boolean;
  activeForDrive: boolean;
}): boolean {
  return !input.managed || input.activeForDrive;
}
