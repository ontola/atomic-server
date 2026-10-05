/**
 * The drive a demo guest chose to create, kept while they make an account.
 *
 * On a hosted build a drive is only made for someone with an account: the
 * guest is sent to the portal to register an email and a way to sign in, and
 * comes back to the app on the email link. This remembers what they picked so
 * they land on the same template, with the same name, instead of the gallery.
 */
export const PENDING_TEMPLATE_KEY = 'atomic.pendingTemplate';

/** Long enough to find the email link, short enough not to surprise later. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export type PendingTemplate = {
  /** The template id, absent for a blank drive. */
  template?: string;
  name: string;
  examples?: boolean;
  at: number;
};

export function savePendingTemplate(
  pending: Omit<PendingTemplate, 'at'>,
  now = Date.now(),
): void {
  try {
    localStorage.setItem(
      PENDING_TEMPLATE_KEY,
      JSON.stringify({ ...pending, at: now }),
    );
  } catch {
    // Without storage they pick the template again after signing up.
  }
}

export function readPendingTemplate(
  now = Date.now(),
): PendingTemplate | undefined {
  try {
    const raw = localStorage.getItem(PENDING_TEMPLATE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<PendingTemplate>;

    if (
      typeof parsed.name !== 'string' ||
      typeof parsed.at !== 'number' ||
      now - parsed.at > PENDING_TTL_MS ||
      (parsed.template !== undefined && typeof parsed.template !== 'string')
    ) {
      localStorage.removeItem(PENDING_TEMPLATE_KEY);

      return undefined;
    }

    return {
      template: parsed.template,
      name: parsed.name,
      examples: parsed.examples === true,
      at: parsed.at,
    };
  } catch {
    return undefined;
  }
}

export function clearPendingTemplate(): void {
  try {
    localStorage.removeItem(PENDING_TEMPLATE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Where to finish creating the pending drive: its name step. */
export function pendingTemplateUrl(pending: PendingTemplate): string {
  const params = new URLSearchParams();
  if (pending.template) params.set('template', pending.template);
  else params.set('blank', '1');
  params.set('name', pending.name);
  if (pending.examples) params.set('examples', '1');

  return `/app/new-drive?${params.toString()}`;
}
