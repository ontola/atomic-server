/** Preserve the billing target when leaving a drive for its account portal. */
export function driveBillingUrl(
  portal: string,
  drive?: string,
  name?: string,
): string {
  const url = new URL('/billing', portal);

  if (drive) url.searchParams.set('drive', drive);

  // Display only: lets the portal label a drive it has no record of (one this
  // account is a member of) with the name the app shows, not "Untitled drive".
  if (drive && name) url.searchParams.set('name', name);

  return url.toString();
}

/** The page on the account portal that explains and sells Cloud Server. */
export function cloudServerSalesUrl(
  portal: string,
  drive?: string,
  name?: string,
): string {
  const url = new URL('/cloud-server', portal);

  if (drive) url.searchParams.set('drive', drive);

  if (drive && name) url.searchParams.set('name', name);

  return url.toString();
}
