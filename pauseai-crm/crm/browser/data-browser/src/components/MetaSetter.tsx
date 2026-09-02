import { core, useResource, useString, useTitle } from '@tomic/react';

import { useSettings } from '../helpers/AppSettings';
import { useCurrentSubject } from '../helpers/useCurrentSubject';

import type { JSX } from 'react';

/** Sets various HTML meta tags, depending on the currently opened resource */
export function MetaSetter(): JSX.Element {
  const { mainColor, darkMode } = useSettings();
  const [subject] = useCurrentSubject();
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  const [name] = useString(resource, core.properties.name);
  const [description] = useString(resource, core.properties.description);

  // `resource.isReady()` is a method call on the mutable Resource proxy.
  // React Compiler memoizes its result on the proxy's reference identity,
  // and the proxy is reused across renders while its internal loading/error
  // state mutates — so the cached value locks in `false` from the first
  // render and the title stays "Atomic Data" forever. `name`, by contrast,
  // is reactive (`useString` → `useSyncExternalStore`), so use its
  // presence as the "have data" signal. See
  // `memory/react-compiler-resource-proxy-pitfall.md`.
  const hasName = name !== undefined && name !== '';
  const displayTitle = hasName ? title : 'Atomic Data';
  const displayDescription =
    hasName && description
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
