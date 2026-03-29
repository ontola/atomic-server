import React from 'react';
import { useSettings } from '../helpers/AppSettings';
import { Main } from '../components/Main';
import { Column } from '../components/Row';
import { NewIdentitySection } from '../components/NewIdentitySection';
import { styled } from 'styled-components';
import { useSavedDrives } from '../hooks/useSavedDrives';
import { useDriveHistory } from '../hooks/useDriveHistory';

/**
 * First-run experience: create an agent, set a name, auto-create a private home drive, then open it.
 * App chrome (sidebar, top bar, AI panel) is hidden on this route via NavWrapper.
 */
export const FullScreenNewIdentityPage: React.FC = () => {
  const { baseURL } = useSettings();
  const [savedDrives] = useSavedDrives();
  const [, addToHistory] = useDriveHistory(savedDrives);
  const host = (() => {
    try {
      return new URL(baseURL).host;
    } catch {
      return baseURL;
    }
  })();

  return (
    <Main subject={baseURL}>
      <Shell>
        <Inner>
          <Column gap='1.5rem'>
            <header>
              <h1>
                Set up your Agent and personal drive on <strong>{host}</strong>.
              </h1>
            </header>
            <NewIdentitySection
              autoStart
              verifySecret
              onAfterCreate={async driveSubject => {
                addToHistory(driveSubject);
              }}
              onDone={() => {
                /* After verify, NewIdentitySection navigates to personalDrive / home */
              }}
            />
          </Column>
        </Inner>
      </Shell>
    </Main>
  );
};

const Shell = styled.div`
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: ${p => p.theme.size(4)};
  box-sizing: border-box;
`;

const Inner = styled.div`
  width: min(100%, ${p => p.theme.containerWidth}rem);
  margin-inline: auto;
`;
