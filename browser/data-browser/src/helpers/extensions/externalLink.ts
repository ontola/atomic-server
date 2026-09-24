// @wc-ignore-file
/**
 * Links an app frame asks the host to open (`openExternal`).
 *
 * The frame is sandboxed without `allow-popups`, so it cannot open anything
 * itself. It asks; the host names the destination host and waits for the
 * person to confirm. Only then does the page open the link, in a new tab,
 * with neither an opener nor a referrer.
 */

/** Longer links are refused rather than drawn in a consent bar. */
export const MAX_EXTERNAL_URL = 4096;

/** The link as a URL, or an error an app can show. http(s) only. */
export function externalLink(value: unknown): URL {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_EXTERNAL_URL
  )
    throw new Error('openExternal takes an http(s) URL');

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('openExternal takes an absolute http(s) URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('openExternal only opens http(s) links');

  // `https://bank.example@evil.example` reads as the bank to a person and
  // goes to evil.example. The bar names the real host either way, but there
  // is no reason for an app to send someone a password in a URL.
  if (url.username || url.password)
    throw new Error(
      'openExternal does not open links with credentials in them',
    );

  if (!url.hostname) throw new Error('openExternal needs a host');

  return url;
}

/**
 * {@link externalLink} as a result rather than an exception, for callers
 * inside a component (the React Compiler skips a component with try/catch).
 */
export function checkExternalLink(
  value: unknown,
): { url: URL } | { error: string } {
  try {
    return { url: externalLink(value) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Opens a confirmed link in a new tab, with no opener and no referrer, so
 * the destination can neither script this page nor learn which page sent it.
 */
export function openInNewTab(
  url: URL,
  open: (url: string, target: string, features: string) => unknown = (
    ...args
  ) => window.open(...args),
): void {
  open(url.href, '_blank', 'noopener,noreferrer');
}
