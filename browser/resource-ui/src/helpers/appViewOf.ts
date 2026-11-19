/** The stored view kind names an app when it contains a URI scheme. */
export function appViewOf(kind: string | undefined): string | undefined {
  return kind?.includes(':') ? kind : undefined;
}
