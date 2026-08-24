const DEFAULT_DRIVE_NAME = 'New Drive';
const MAX_NAME_LENGTH = 48;

/**
 * A first-pass drive title from the user's setup message. The agent can
 * rename the drive after it has researched a company website or similar hint.
 */
export function driveNameFromPrompt(text: string): string {
  const trimmed = text.trim();

  if (!trimmed) {
    return DEFAULT_DRIVE_NAME;
  }

  const urlMatch = trimmed.match(/https?:\/\/[^\s]+/i);

  if (urlMatch) {
    try {
      const host = new URL(urlMatch[0]).hostname.replace(/^www\./, '');

      if (host) {
        return host;
      }
    } catch {
      // Not a usable URL — fall through to the first line.
    }
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;

  if (firstLine.length <= MAX_NAME_LENGTH) {
    return firstLine;
  }

  return `${firstLine.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…`;
}
