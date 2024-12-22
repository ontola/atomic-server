import {
  core,
  unknownSubject,
  useResource,
  useString,
  useTitle,
} from '@tomic/react';

import { useSettings } from '../helpers/AppSettings';
import { useCurrentSubject } from '../helpers/useCurrentSubject';

import type { JSX } from 'react';

/** Sets various HTML meta tags, depending on the currently opened resource */
export function MetaSetter(): JSX.Element {
  const { mainColor, darkMode } = useSettings();
  const [subject] = useCurrentSubject();
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  const [description] = useString(resource, core.properties.description);
  const hasResource = resource.isReady() && resource.subject !== unknownSubject;

  const displayTitle = hasResource && title ? title : 'Atomic Data';
  const displayDescription =
    hasResource && description
      ? description
      : 'The easiest way to create and share linked data.';

  return (
    <>
      <title>{displayTitle}</title>
      <meta name='theme-color' content={darkMode ? 'black' : 'white'} />
      <meta
        name='apple-mobile-web-app-status-bar-style'
        content={darkMode ? 'black' : 'default'}
      />
      <meta name='msapplication-TileColor' content={mainColor} />
      <meta name='description' content={displayDescription} />
      <meta property='og:title' content={displayTitle} />
      <meta property='og:description' content={displayDescription} />
      <meta property='og:url' content={subject} />
    </>
  );
}
