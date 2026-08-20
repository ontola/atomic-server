import * as React from 'react';
import { Client } from '@tomic/react';
import ResourcePage from '../views/ResourcePage';
import { Search } from './Search/SearchRoute';
import { About } from './AboutRoute';
import { createRoute } from '@tanstack/react-router';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';
import { DidResolveOnShow } from '../helpers/DidResolveOnShow';

export type ShowRouteSearch = {
  subject: string;
  /**
   * The active View of a Table, so switching tabs is linkable and lands in
   * browser history. Absent = the table's default view.
   */
  view?: string;
  /** Optional pkarr agent hint for DID resolution (share links). */
  agent?: string;
  /** Optional node DID hint for direct dial (share links). */
  node?: string;
};

export const ShowRoute = createRoute({
  path: pathNames.show,
  component: () => <ShowComponent />,
  getParentRoute: () => appRoute,
  validateSearch: (search): ShowRouteSearch => ({
    subject: (search.subject as string) ?? '',
    view: (search.view as string) || undefined,
    agent: (search.agent as string) || undefined,
    node: (search.node as string) || undefined,
  }),
});

/** Renders either the Welcome page, an Individual resource, or search results. */
export const ShowComponent: React.FunctionComponent = () => {
  // Value shown in navbar, after Submitting
  const { subject, agent, node } = ShowRoute.useSearch({
    select: state => ({
      subject: state.subject,
      agent: state.agent,
      node: state.node,
    }),
  });

  if (subject === undefined || subject === '') {
    return <About />;
  }

  if (Client.isValidSubject(subject)) {
    return (
      <>
        <DidResolveOnShow subject={subject} agent={agent} node={node} />
        <ResourcePage key={subject} subject={subject} />
      </>
    );
  } else {
    return <Search />;
  }
};
