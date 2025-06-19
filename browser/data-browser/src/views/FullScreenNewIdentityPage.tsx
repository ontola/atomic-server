import React, { useRef } from 'react';
import { useSettings } from '../helpers/AppSettings';
import { Main } from '../components/Main';
import { Column } from '../components/Row';
import { NewIdentitySection } from '../components/NewIdentitySection';
import { css, styled } from 'styled-components';
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
  const stepDotsSlotRef = useRef<HTMLDivElement | null>(null);

  return (
    <Main subject={baseURL}>
      <Shell>
        <Inner>
          <Card>
            <Column gap='1.5rem'>
              <NewIdentitySection
                autoStart
                verifySecret
                stepIndicatorPortal={stepDotsSlotRef.current}
                onAfterCreate={async driveSubject => {
                  addToHistory(driveSubject);
                }}
                onDone={() => {
                  /* After verify, NewIdentitySection navigates to personalDrive / home */
                }}
              />
            </Column>
          </Card>
          <StepDotsSlot ref={stepDotsSlotRef} />
        </Inner>
      </Shell>
    </Main>
  );
};

const Shell = styled.div`
  min-height: ${p => p.theme.heights.fullPage};
  display: flex;
  align-items: center;
  justify-content: center;
  padding: ${p => p.theme.size(7)} ${p => p.theme.size(5)};
  box-sizing: border-box;
  background: ${p => p.theme.colors.bgBody};

  ${p =>
    p.theme.darkMode
      ? css`
          background-image: radial-gradient(
              900px 420px at 20% 15%,
              rgba(0, 194, 255, 0.14),
              transparent 60%
            ),
            radial-gradient(
              800px 460px at 85% 25%,
              rgba(255, 255, 255, 0.07),
              transparent 62%
            ),
            radial-gradient(
              900px 520px at 50% 110%,
              rgba(0, 194, 255, 0.07),
              transparent 60%
            );
        `
      : css`
          background-image: radial-gradient(
              900px 420px at 18% 15%,
              rgba(0, 194, 255, 0.12),
              transparent 60%
            ),
            radial-gradient(
              800px 460px at 85% 25%,
              rgba(0, 0, 0, 0.06),
              transparent 62%
            ),
            radial-gradient(
              900px 520px at 50% 110%,
              rgba(49, 120, 198, 0.08),
              transparent 60%
            );
        `}
`;

const Inner = styled.div`
  width: 100%;
  max-width: 40rem;
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
`;

const Card = styled.div`
  box-sizing: border-box;
  width: 100%;
  max-width: 36rem;
  margin-inline: auto;
  padding: ${p => p.theme.size(7)};
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  background: ${p => p.theme.colors.bg1};
  box-shadow: ${p => p.theme.boxShadowSoft};
  backdrop-filter: blur(10px);
`;

const StepDotsSlot = styled.div`
  margin-top: ${p => p.theme.size(5)};
  min-height: 1.25rem;

  & [data-step-dots='true'] {
    display: flex;
    justify-content: center;
    gap: 6px;
  }
`;
