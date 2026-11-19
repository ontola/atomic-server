import { server, useStore } from '@tomic/react';
import { useId, useState, type JSX } from 'react';
import { Button } from '@components/Button';
import { ErrorLook } from '@components/ErrorLook';
import { Column, Row } from '@components/Row';
import { DrivesCard } from '@components/Drives/DrivesCard';
import { NewInstanceButton } from '@components/NewInstanceButton';
import {
  InputStyled,
  InputWrapper,
  LabelStyled,
} from '@components/forms/InputStyles';
import { useAccountDriveCatalog } from '@hooks/useAccountDriveCatalog';
import { useDriveHistory } from '@hooks/useDriveHistory';
import { usePrivateDrive } from '@hooks/usePrivateDrive';
import { useSavedDrives } from '@hooks/useSavedDrives';
import { constructOpenURL } from '@helpers/navigation';
import { useSettings } from '@helpers/AppSettings';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { SettingsSection } from './SettingsSection';
import { settingsKeywords } from './settingsKeywords';

/** The drives you have. A drive's own configuration is not yours, so it
 *  lives with the drive (the gear on its page), not here. */
export function DriveSettings(): JSX.Element {
  return (
    <SettingsSection
      label='Drives'
      id='drive'
      childSearchKeywords={settingsKeywords.drive}
    >
      <Column gap='0.75rem'>
        <DriveLists />
      </Column>
    </SettingsSection>
  );
}

function DriveLists(): JSX.Element {
  const { drive, setDrive } = useSettings();
  const navigate = useNavigateWithTransition();
  const { privateDrive } = usePrivateDrive();
  const [savedDrives] = useSavedDrives();
  const [history, addToHistory, removeFromHistory] =
    useDriveHistory(savedDrives);

  // One list, with the private drive pinned to the top of it.
  const catalog = useAccountDriveCatalog(
    privateDrive ? [privateDrive, ...savedDrives] : savedDrives,
  );
  const myDrives = catalog.subjects;
  // Still kept out of Recently visited: it is not somewhere you happened to go.
  const recentDrives = history.filter(
    subject =>
      subject !== privateDrive &&
      !catalog.removed.includes(subject) &&
      !myDrives.includes(subject),
  );

  const driveUrlId = useId();
  const [driveInput, setDriveInput] = useState('');
  const [driveErr, setDriveErr] = useState<Error | undefined>();
  const [showDriveUrl, setShowDriveUrl] = useState(false);
  const store = useStore();

  function handleSetDrive(url: string) {
    setDrive(url);
    addToHistory(url);
    navigate(constructOpenURL(url));
  }

  function handleOpenDriveInput() {
    try {
      handleSetDrive(driveInput);
    } catch (e) {
      setDriveErr(e as Error);
    }
  }

  return (
    <>
      <SettingsSection
        label='My drives'
        initialState
        childSearchKeywords='private drive star saved open url did'
      >
        <Column gap='0.75rem'>
          {/* The URL field stays hidden until asked for: it is the rarer of
              the two actions by a wide margin. */}
          <Row gap='0.5rem'>
            <NewInstanceButton
              klass={server.classes.drive}
              subtle
              icon
              label='New'
            />
            <Button
              subtle
              aria-label='Open a drive by URL'
              title='Open a drive by URL or DID'
              onClick={() => setShowDriveUrl(open => !open)}
              aria-expanded={showDriveUrl}
              data-test='open-drive-by-url'
            >
              Open
            </Button>
          </Row>
          {showDriveUrl && (
            <div>
              <LabelStyled htmlFor={driveUrlId}>
                Open a drive by URL or DID
              </LabelStyled>
              <Row>
                <InputWrapper>
                  <InputStyled
                    id={driveUrlId}
                    data-testid='drive-url-input'
                    value={driveInput}
                    onChange={e => setDriveInput(e.target.value)}
                    placeholder='Enter a Drive DID or URL'
                    autoFocus
                  />
                </InputWrapper>
                <Button
                  onClick={handleOpenDriveInput}
                  disabled={!driveInput || drive === driveInput}
                  data-test='drive-url-save'
                >
                  Open
                </Button>
              </Row>
              {driveErr && <ErrorLook>{driveErr.message}</ErrorLook>}
            </div>
          )}
          <DrivesCard
            drives={myDrives}
            labels={Object.fromEntries(
              catalog.entries
                .filter(
                  e =>
                    e.drive_name &&
                    !store.resources.get(e.drive_subject)?.isReady(),
                )
                .map(e => [e.drive_subject, e.drive_name!]),
            )}
            testId='my-drives'
            privateDrive={privateDrive}
            onDriveSelect={handleSetDrive}
          />
        </Column>
      </SettingsSection>
      {recentDrives.length > 0 && (
        <SettingsSection
          label='Recently visited'
          initialState
          childSearchKeywords='history recent star only stored on this device'
        >
          <DrivesCard
            drives={recentDrives}
            onDriveSelect={handleSetDrive}
            onDriveRemove={removeFromHistory}
          />
        </SettingsSection>
      )}
    </>
  );
}
