import { isRunningInTauri } from '../tauri';

/**
 * Whether this browser can use the provider's session cookie.
 *
 * Hosted app subdomains share their portal's site; a self-hosted browser or
 * native WebView must link and use a bearer token instead. Cookies ignore
 * ports, so same-host local development works across ports, but a scheme
 * change is a different site. Relative API bases resolve against this page.
 */
export function canHoldProviderCookie(providerUrl: string | null): boolean {
  if (
    !providerUrl ||
    typeof window === 'undefined' ||
    !window.location ||
    isRunningInTauri()
  ) {
    return false;
  }

  try {
    const here = new URL(window.location.href);
    const provider = new URL(providerUrl, here);

    if (
      !/^https?:$/.test(here.protocol) ||
      provider.protocol !== here.protocol ||
      provider.username ||
      provider.password
    ) {
      return false;
    }

    return (
      here.hostname === provider.hostname ||
      here.hostname.endsWith(`.${provider.hostname}`)
    );
  } catch {
    return false;
  }
}
