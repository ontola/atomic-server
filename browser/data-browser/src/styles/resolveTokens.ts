/**
 * Resolves `var(--token)` references against the live document.
 *
 * Needed wherever a token value has to leave the document that defines it —
 * today that is the plugin sandbox, whose stylesheet is injected into an
 * iframe where `:root` is a different element and our custom properties do not
 * exist. Handing that iframe the literal string `var(--color-bg)` would
 * silently produce an unstyled plugin.
 *
 * Only for crossing a document boundary. Inside the app, pass the reference
 * along and let the cascade do the work: resolving early freezes the value, so
 * it stops following the theme.
 */

/** Replaces every `var(--x)` (and any `var()` inside it) with its value. */
export function resolveCssVars(value: string, depth = 0): string {
  if (typeof window === 'undefined' || depth > 10 || !value.includes('var(')) {
    return value;
  }

  const computed = getComputedStyle(document.documentElement);

  const resolved = value.replace(
    /var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g,
    (whole, name: string, fallback: string | undefined) => {
      const own = computed.getPropertyValue(name).trim();

      if (own) return own;

      return fallback?.trim() ?? whole;
    },
  );

  return resolved === value ? value : resolveCssVars(resolved, depth + 1);
}
