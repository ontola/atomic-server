import { Button } from '../../components/Button';
import {
  InputStyled,
  InputWrapper,
  LabelStyled,
} from '../../components/forms/InputStyles';
import { useId, useState, type JSX } from 'react';
import { useSettings } from '../../helpers/AppSettings';
import { ContainerWide } from '../../components/Containers';
import { Column, Row } from '../../components/Row';
import { useDriveHistory } from '../../hooks/useDriveHistory';
import { DrivesCard } from './DrivesCard';
import { styled } from 'styled-components';
import { useSavedDrives } from '../../hooks/useSavedDrives';
import { constructOpenURL } from '../../helpers/navigation';
import { ErrorLook } from '../../components/ErrorLook';
import { Main } from '../../components/Main';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { createRoute } from '@tanstack/react-router';
import { pathNames } from '../paths';
import { appRoute } from '../RootRoutes';

export const ServerSettingsRoute = createRoute({
  path: pathNames.serverSettings,
  component: () => <SettingsServer />,
  getParentRoute: () => appRoute,
});

function SettingsServer(): JSX.Element {
  const currentDriveId = useId();
  const { drive, setDrive } = useSettings();
  const navigate = useNavigateWithTransition();

  const [driveInput, setDriveInput] = useState<string>(drive);
  const [driveErr, setDriveErr] = useState<Error | undefined>();

  const [savedDrives] = useSavedDrives();

  const [history, addDriveToHistory, removeFromHistory] =
    useDriveHistory(savedDrives);

  function handleSetDrive(url: string) {
    try {
      setDrive(url);
      setDriveInput(url);
      addDriveToHistory(url);
      navigate(constructOpenURL(url));
    } catch (e) {
      setDriveErr(e);
    }
  }

  return (
    <Main>
      <ContainerWide>
        <Column>
          <Heading>Drive Configuration</Heading>

          <Heading as='h2'>Saved Drives</Heading>
          <DrivesCard
            showNewOption
            drives={savedDrives}
            onDriveSelect={subject => handleSetDrive(subject)}
          />

          <LabelStyled htmlFor={currentDriveId}>Custom Drive URL</LabelStyled>
          <Row>
            <InputWrapper>
              <InputStyled
                id={currentDriveId}
                data-testid='drive-url-input'
                value={driveInput}
                onChange={e => setDriveInput(e.target.value)}
                placeholder='Enter a Drive DID or URL'
              />
            </InputWrapper>
            <Button
              onClick={() => handleSetDrive(driveInput)}
              disabled={drive === driveInput}
              data-test='drive-url-save'
            >
              Set
            </Button>
          </Row>
          {driveErr && <ErrorLook>{driveErr?.message}</ErrorLook>}

          <Heading as='h2'>History</Heading>
          <DrivesCard
            drives={history}
            onDriveSelect={subject => handleSetDrive(subject)}
            onDriveRemove={subject => removeFromHistory(subject)}
          />

          <p>
            Server settings have moved to the <a href='/app/sync'>Sync page</a>.
          </p>
        </Column>
      </ContainerWide>
    </Main>
  );
}

const Heading = styled.h1`
  margin: 0;
`;
