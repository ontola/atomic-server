import { useLocation } from 'react-router';
import ResourcePage from '../views/ResourcePage';

import type { JSX } from 'react';

/** Show a resource where the domain matches the current domain */
function Local(): JSX.Element {
  const { pathname, search } = useLocation();

  const subject = window.location.origin + pathname + search;

  // The key makes sure the component re-renders when it changes
  return <ResourcePage key={subject} subject={subject} />;
}

export default Local;
