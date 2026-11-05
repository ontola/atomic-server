// @wc-ignore-file
import { cloudServerSalesUrl } from './driveBillingUrl';
import { openExternal } from './openExternal';
import { getRememberedManagedPortalUrl, safePortalUrl } from './managed/api';
import { getManagedPortalUrl } from './managed/cloudSync';

/**
 * The account portal this app sells Cloud Server on, if it has one: the
 * runtime/env portal, else the one remembered from an earlier sign-in.
 */
export function cloudServerPortal(): string | undefined {
  return safePortalUrl(
    getManagedPortalUrl() ?? getRememberedManagedPortalUrl(),
  );
}

/** Open the portal's Cloud Server page for `drive`. False when there is no portal. */
export async function openCloudServerSales(
  drive: string,
  name?: string,
): Promise<boolean> {
  const portal = cloudServerPortal();

  if (!portal) return false;

  await openExternal(cloudServerSalesUrl(portal, drive, name));

  return true;
}
