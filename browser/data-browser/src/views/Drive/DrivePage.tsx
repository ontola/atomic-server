import { Datatype, core, useCanWrite, type Server } from '@tomic/react';
import { ContainerNarrow } from '@components/Containers';
import { Button } from '@components/Button';
import { useSettings } from '@helpers/AppSettings';
import { ResourcePageProps } from '../ResourcePage';
import { EditableTitle } from '@components/EditableTitle';
import { useVisibleDriveChildren } from '@hooks/useVisibleDriveChildren';
import { useIsPrivateDrive } from '@hooks/useIsPrivateDrive';
import { PrivateDriveBadge } from '@components/Drives/PrivateDriveBadge';
import { ResourceCoverImage } from '@components/ResourceDecorations';
import { Column, Row } from '@components/Row';
import {
  DriveSwitcher,
  DriveSwitcherChevronTrigger,
} from '@components/SideBar/DriveSwitcher';
import { styled } from 'styled-components';
import { useDialog } from '@components/Dialog/useDialog';
import { FaGear } from 'react-icons/fa6';
import { useEffect, useState, type JSX } from 'react';
import { useVectorIndexStatus } from '@hooks/useVectorIndexStatus';
import { VectorIndexingIndicator } from '@components/VectorIndexingIndicator';
import { ValueFormAddButton } from '@components/forms/ValueForm/ValueFormAddButton';
import { FileDropZone } from '@components/forms/FileDropzone/FileDropzone';
import { DriveSettingsDialog } from './DriveSettingsDialog';
import { GettingStartedCard } from './GettingStartedCard';
import { EmptyDriveStart } from './EmptyDriveStart';
import {
  ActivityFeed,
  DrivePeople,
  QuickCreateCards,
  ResourceList,
  SectionTitle,
} from './DriveHome';

/** A View for Drives, which function similar to a homepage or dashboard. */
function DrivePage({ resource }: ResourcePageProps<Server.Drive>): JSX.Element {
  const { drive: baseURL, setDrive: setBaseURL } = useSettings();
  const { subjects: subResources, loading } = useVisibleDriveChildren(
    resource.subject,
  );
  const [dialogProps, showSettings, , settingsOpen] = useDialog();

  const vectorIndexing = useVectorIndexStatus();

  const canEdit = useCanWrite(resource);
  const empty = useSettledEmpty(!loading && subResources.length === 0);
  // A starter being added: the drive has its first resource, not all of them.
  const [filling, setFilling] = useState(false);
  const showStart =
    canEdit && (filling || (empty && subResources.length === 0));
  const isPrivateDrive = useIsPrivateDrive(resource.subject);

  if (!baseURL) {
    setBaseURL(resource.subject);
  }

  return (
    <>
      <ResourceCoverImage resource={resource} />
      <FileDropZone parentResource={resource}>
        <ContainerNarrow>
          <Column gap='2rem'>
            <Header>
              <Row align='center' wrapItems gap='1rem'>
                <EditableTitle
                  resource={resource}
                  withDecorations
                  // Its subject is derived from your key: there is exactly one and
                  // it cannot be swapped. A name like "Q3 Launch" on it would be a
                  // name that lies about what the thing is.
                  lockedReason={
                    isPrivateDrive
                      ? 'Your private drive keeps its name. It is tied to your account, not to a project.'
                      : undefined
                  }
                />
                <DriveSwitcher Trigger={DriveSwitcherChevronTrigger} />
                {isPrivateDrive && <PrivateDriveBadge />}
                {vectorIndexing && <VectorIndexingIndicator />}
              </Row>
              <Row align='center' wrapItems gap='0.75rem'>
                <DrivePeople />
                {baseURL !== resource.subject && (
                  <Button subtle onClick={() => setBaseURL(resource.subject)}>
                    Set as current drive
                  </Button>
                )}
                <Button
                  subtle
                  onClick={showSettings}
                  data-testid='drive-settings-button'
                >
                  <FaGear /> Drive settings
                </Button>
              </Row>
            </Header>

            {showStart && (
              <EmptyDriveStart drive={resource.subject} onActive={setFilling} />
            )}

            <GettingStartedCard drive={resource} canEdit={canEdit} />

            <ValueFormAddButton
              resource={resource}
              propertyURL={core.properties.description}
              datatype={Datatype.MARKDOWN}
              buttonLabel='Add description'
            />

            <ActivityFeed
              key={resource.subject}
              subjects={subResources}
              drive={resource.subject}
            />

            {!showStart && (subResources.length > 0 || !canEdit) && (
              <section>
                <SectionTitle>Resources</SectionTitle>
                {subResources.length > 0 ? (
                  <ResourceList
                    key={resource.subject}
                    subjects={subResources}
                  />
                ) : (
                  <p>Nothing here yet.</p>
                )}
              </section>
            )}

            {canEdit && !showStart && subResources.length > 0 && (
              <QuickCreateCards parent={resource.subject} />
            )}
          </Column>
        </ContainerNarrow>
      </FileDropZone>
      <DriveSettingsDialog
        drive={resource}
        dialogProps={dialogProps}
        isOpen={settingsOpen}
      />
    </>
  );
}

/**
 * Whether the drive has stayed empty for a moment. The child list is built in
 * steps, so it reads empty for a beat while a full drive is still loading;
 * the empty-drive start must not flash up then.
 */
function useSettledEmpty(empty: boolean): boolean {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!empty) {
      setSettled(false);

      return;
    }

    const timer = setTimeout(() => setSettled(true), 400);

    return () => clearTimeout(timer);
  }, [empty]);

  return settled;
}

export default DrivePage;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
`;
