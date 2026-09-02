import type { Version } from '@tomic/react';

import type { JSX } from 'react';

const formatter = new Intl.DateTimeFormat('default', {
  month: 'long',
  year: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

export interface VersionTitleProps {
  version: Version;
}
export function VersionTitle({ version }: VersionTitleProps): JSX.Element {
  const date = new Date(version.timestamp);
  const formattedDate = formatter.format(date);

  return (
    <span>
      Edited <time dateTime={date.toISOString()}>{formattedDate}</time>
      {version.peer && <> by peer {version.peer.slice(0, 8)}...</>}
      {version.message && <> — {version.message}</>}
    </span>
  );
}
