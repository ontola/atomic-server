/**
 * True when `subject` is the Atomic server's URL root (path `/`), for comparing
 * with {@link useSettings} `baseURL`. Used to show the self-host welcome gate.
 */
export function isAtomicServerHome(subject: string, baseURL: string): boolean {
  try {
    const sub = new URL(subject);
    const base = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`);

    if (sub.origin !== base.origin) {
      return false;
    }

    const path = sub.pathname.replace(/\/$/, '') || '/';

    return path === '/';
  } catch {
    return false;
  }
}
