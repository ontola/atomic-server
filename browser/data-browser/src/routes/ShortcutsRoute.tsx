import * as React from 'react';
import { styled } from 'styled-components';
import { ContainerNarrow } from '../components/Containers';
import { listShortcutHelp } from '../actions/catalog';
import { Shortcut } from '../components/Shortcut';
import { Main } from '../components/Main';
import { createRoute } from '@tanstack/react-router';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';

export const ShortcutsRoute = createRoute({
  path: pathNames.shortcuts,
  component: () => <Shortcuts />,
  getParentRoute: () => appRoute,
});

/** List of all the keyboard shortcuts, rendered from the action registry. */
const Shortcuts: React.FunctionComponent = () => {
  const entries = listShortcutHelp();

  return (
    <Main>
      <ContainerNarrow>
        <h1>Keyboard shortcuts</h1>
        <h3>Global</h3>
        {entries.map(entry => (
          <p key={entry.id}>
            <Key shortcut={entry.shortcut} /> {entry.label}
          </p>
        ))}
      </ContainerNarrow>
    </Main>
  );
};

const Key = styled(Shortcut)`
  font-size: 1rem;
`;
