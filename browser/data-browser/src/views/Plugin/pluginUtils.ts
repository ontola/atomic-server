import type {
  PluginPermission,
  PluginPermissionType,
} from '@chunks/Plugins/plugins';

export function isPluginPermissions(
  permissions: unknown,
): permissions is PluginPermission[] {
  if (!Array.isArray(permissions)) return false;

  return permissions.every(
    permission =>
      typeof permission === 'object' &&
      'permission' in permission &&
      typeof permission.permission === 'string' &&
      'reason' in permission &&
      typeof permission.reason === 'string',
  );
}

export function hasPermission(
  permissions: unknown,
  permission: PluginPermissionType,
): boolean {
  if (!isPluginPermissions(permissions)) return false;

  return permissions.some(p => p.permission === permission);
}
