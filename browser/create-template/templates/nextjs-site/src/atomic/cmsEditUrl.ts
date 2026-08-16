/** Data Browser edit form for a resource. Same contract as Cmd/Ctrl+E in the app. */
export function cmsEditUrl(cmsOrigin: string, subject: string): string {
  const origin = cmsOrigin.endsWith('/') ? cmsOrigin : `${cmsOrigin}/`;
  const url = new URL('app/edit', origin);
  url.searchParams.set('subject', subject);

  return url.toString();
}
