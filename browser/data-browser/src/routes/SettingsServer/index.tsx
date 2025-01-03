import { Button } from '../../components/Button';
import {
  InputStyled,
  InputWrapper,
  LabelStyled,
} from '../../components/forms/InputStyles';
import { useState, type JSX } from 'react';
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
  const { drive: baseURL, setDrive: setBaseURL } = useSettings();
  const navigate = useNavigateWithTransition();
  const [baseUrlInput, setBaseUrlInput] = useState<string>(baseURL);
  const [baseUrlErr, setErrBaseUrl] = useState<Error | undefined>();

  const [savedDrives] = useSavedDrives();

  const [history, addDriveToHistory, removeFromHistory] =
    useDriveHistory(savedDrives);

  function handleSetBaseUrl(url: string) {
    try {
      setBaseURL(url);
      setBaseUrlInput(url);
      addDriveToHistory(url);
      navigate(constructOpenURL(url));
    } catch (e) {
      setErrBaseUrl(e);
    }
  }

  return (
    <Main>
      <ContainerWide>
        <Column>
          <Heading>Drive Configuration</Heading>
          <LabelStyled>Current Drive</LabelStyled>
          <Row>
            <InputWrapper>
              <InputStyled
                data-test='server-url-input'
                value={baseUrlInput}
                onChange={e => setBaseUrlInput(e.target.value)}
              />
            </InputWrapper>
            <Button
              onClick={() => handleSetBaseUrl(baseUrlInput)}
              disabled={baseURL === baseUrlInput}
              data-test='server-url-save'
            >
              Save
            </Button>
          </Row>
          {baseUrlErr && <ErrorLook>{baseUrlErr?.message}</ErrorLook>}
          <Heading as='h2'>Saved</Heading>
          <DrivesCard
            showNewOption
            drives={savedDrives}
            onDriveSelect={subject => handleSetBaseUrl(subject)}
          />
          <Heading as='h2'>Other</Heading>
          <DrivesCard
            drives={history}
            onDriveSelect={subject => handleSetBaseUrl(subject)}
            onDriveRemove={subject => removeFromHistory(subject)}
          />
        </Column>
      </ContainerWide>
    </Main>
  );
}

const Heading = styled.h1`
  margin: 0;
`;
