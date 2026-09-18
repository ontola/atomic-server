// @wc-ignore-file
/** Keep old saved resources readable without rewriting their names. */
export function websiteVersionName(name: string): string {
  const match = /^Website release (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/.exec(name);
  if (!match) return name;
  const date = new Date(match[1]);
  if (!Number.isFinite(date.getTime())) return name;

  return `Version · ${new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)}`;
}
