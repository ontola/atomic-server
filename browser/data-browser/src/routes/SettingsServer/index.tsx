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
import { ServersCard } from './ServersCard';
import { styled } from 'styled-components';
import { useSavedDrives } from '../../hooks/useSavedDrives';
import { constructOpenURL } from '../../helpers/navigation';
import { ErrorLook } from '../../components/ErrorLook';
import { Main } from '../../components/Main';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { createRoute } from '@tanstack/react-router';
import { pathNames } from '../paths';
import { appRoute } from '../RootRoutes';
import { serverURLStorage } from '../../helpers/serverURLStorage';
import { isURL } from '../../helpers/isURL';

export const ServerSettingsRoute = createRoute({
  path: pathNames.serverSettings,
  component: () => <SettingsServer />,
  getParentRoute: () => appRoute,
});

function SettingsServer(): JSX.Element {
  const currentDriveId = useId();
  const currentServerId = useId();
  const { drive, setDrive, baseURL, setServer } = useSettings();
  const navigate = useNavigateWithTransition();

  const isHttpDrive = isURL(drive);

  const [driveInput, setDriveInput] = useState<string>(drive);
  const [driveErr, setDriveErr] = useState<Error | undefined>();

  const [serverInput, setServerInput] = useState<string>(baseURL);
  const [serverErr, setServerErr] = useState<Error | undefined>();

  const [savedDrives] = useSavedDrives();
  const [knownServers, setKnownServers] = useState<string[]>(
    serverURLStorage.getKnownServers(),
  );

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

  function handleSetServer(url: string) {
    try {
      setServer(url);
      setServerInput(url);
      setKnownServers(serverURLStorage.getKnownServers());
    } catch (e) {
      setServerErr(e);
    }
  }

  function handleRemoveServer(url: string) {
    serverURLStorage.removeKnownServer(url);
    setKnownServers(serverURLStorage.getKnownServers());
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

          <Heading as='h2'>Gateway Server</Heading>
          {isHttpDrive ? (
            <p>
              The gateway is currently locked to{' '}
              <strong>{new URL(drive).origin}</strong> because you are using an
              HTTP-based drive.
            </p>
          ) : (
            <p>
              The gateway server is used to resolve DIDs and fetch data from the
              network.
            </p>
          )}

          <ServersCard
            servers={knownServers}
            onServerSelect={handleSetServer}
            onServerRemove={handleRemoveServer}
            disabled={isHttpDrive}
          />

          <LabelStyled htmlFor={currentServerId}>
            Add Gateway by URL
          </LabelStyled>
          <Row>
            <InputWrapper>
              <InputStyled
                id={currentServerId}
                data-testid='server-url-input'
                value={isHttpDrive ? new URL(drive).origin : serverInput}
                disabled={isHttpDrive}
                onChange={e => setServerInput(e.target.value)}
                placeholder='https://example.com'
              />
            </InputWrapper>
            <Button
              onClick={() => handleSetServer(serverInput)}
              disabled={isHttpDrive || baseURL === serverInput}
              data-test='server-url-save'
            >
              {isHttpDrive ? 'Locked' : 'Set Active'}
            </Button>
          </Row>
          {serverErr && <ErrorLook>{serverErr?.message}</ErrorLook>}
        </Column>
      </ContainerWide>
    </Main>
  );
}

const Heading = styled.h1`
  margin: 0;
`;
