// @wc-ignore-file
import { cloudServerSalesUrl } from './driveBillingUrl';
import { openExternal } from './openExternal';
import { getAccountServiceUrl } from './managed/cloudSync';

/** Open the account service's Cloud Server page for `drive`. False when there is no service. */
export async function openCloudServerSales(
  drive: string,
  name?: string,
): Promise<boolean> {
  const portal = getAccountServiceUrl();

  if (!portal) return false;

  await openExternal(cloudServerSalesUrl(portal, drive, name));

  return true;
}
