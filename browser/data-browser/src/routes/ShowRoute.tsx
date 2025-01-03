import * as React from 'react';
import { Client } from '@tomic/react';
import ResourcePage from '../views/ResourcePage';
import { Search } from './SearchRoute';
import { About } from './AboutRoute';
import { createRoute } from '@tanstack/react-router';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';

export type ShowRouteSearch = {
  subject: string;
};

export const ShowRoute = createRoute({
  path: pathNames.show,
  component: () => <ShowComponent />,
  getParentRoute: () => appRoute,
  validateSearch: (search): ShowRouteSearch => ({
    subject: (search.subject as string) ?? '',
  }),
});

/** Renders either the Welcome page, an Individual resource, or search results. */
export const ShowComponent: React.FunctionComponent = () => {
  // Value shown in navbar, after Submitting
  const subject = ShowRoute.useSearch({ select: state => state.subject });

  if (subject === undefined || subject === '') {
    return <About />;
  }

  if (Client.isValidSubject(subject)) {
    return <ResourcePage key={subject} subject={subject} />;
  } else {
    return <Search />;
  }
};
