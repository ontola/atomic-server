import {
  Datatype,
  dataBrowser,
  server,
  useArray,
  useCanWrite,
  useProperty,
  useResource,
  useStore,
  useTitle,
  type Resource,
  type Server,
} from '@tomic/react';
import { lazy, Suspense, useId, useState, type JSX } from 'react';
import { FaXmark } from 'react-icons/fa6';
import { LuChevronsUpDown } from 'react-icons/lu';
import { styled } from 'styled-components';
import { Button } from '@components/Button';
import { ErrorLook } from '@components/ErrorLook';
import { Column, Row } from '@components/Row';
import { DrivesCard } from '@components/Drives/DrivesCard';
import { NewInstanceButton } from '@components/NewInstanceButton';
import { DriveSwitcher } from '@components/SideBar/DriveSwitcher';
import type { DropdownTriggerProps } from '@components/Dropdown/DropdownTrigger';
import {
  InputStyled,
  InputWrapper,
  LabelStyled,
} from '@components/forms/InputStyles';
import { onboardingKeys } from '@hooks/useOnboardingProgress';
import { useLocalStorage } from '@hooks/useLocalStorage';
import { useAccountDriveCatalog } from '@hooks/useAccountDriveCatalog';
import { useDriveHistory } from '@hooks/useDriveHistory';
import { usePrivateDrive } from '@hooks/usePrivateDrive';
import { useSavedDrives } from '@hooks/useSavedDrives';
import InputSwitcher from '@components/forms/InputSwitcher';
import { Tag } from '@components/Tag/Tag';
import { CreateTagRow } from '@components/Tag/CreateTagRow';
import { ValueFormAddButton } from '@components/forms/ValueForm/ValueFormAddButton';
import { constructOpenURL } from '@helpers/navigation';
import { driveDisplayName } from '@helpers/driveDisplayName';
import { useSettings } from '@helpers/AppSettings';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { useGettingStartedAgent } from '../../views/Drive/GettingStartedCard';
import { PluginList } from '../../views/Drive/PluginList';
import { ExternalAppList } from '../../views/Drive/ExternalAppList';
import { SettingCheckbox } from './SettingCheckbox';
import { SettingsSection } from './SettingsSection';

const NewPluginButton = lazy(() => import('@chunks/Plugins/NewPluginButton'));

/** Shows the current drive's name; picking another drive happens in the menu. */
function CurrentDriveTrigger({
  onClick,
  menuId,
  isActive,
  ref,
  id,
}: DropdownTriggerProps) {
  const { drive } = useSettings();
  const [title] = useTitle(useResource(drive));

  return (
    <Button
      subtle
      id={id}
      aria-controls={menuId}
      aria-expanded={isActive}
      aria-haspopup='menu'
      onClick={onClick}
      ref={ref}
      title='Switch Drive'
    >
      {driveDisplayName(title, drive)} <LuChevronsUpDown />
    </Button>
  );
}

/** The current drive: switching, its configuration, and the drives you have. */
export function DriveSettings(): JSX.Element {
  const { drive } = useSettings();

  return (
    <SettingsSection
      label='Drive'
      id='drive'
      childSearchKeywords='drive drives switch current tags llm instructions ontology browser sync server apps plugins getting started my drives recently visited open url did new'
    >
      <Column gap='0.75rem'>
        <Row>
          <DriveSwitcher Trigger={CurrentDriveTrigger} />
        </Row>
        {drive && <CurrentDriveSettings subject={drive} />}
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

/** The drive's configuration. */
function CurrentDriveSettings({ subject }: { subject: string }): JSX.Element {
  const drive = useResource<Server.Drive>(subject);
  const defaultOntologyProp = useProperty(server.properties.defaultOntology);
  const signalingUrlProp = useProperty(server.properties.signalingUrl);
  const canEdit = useCanWrite(drive);

  return (
    <>
      <GettingStartedSetting drive={drive} canEdit={canEdit} />
      <SettingsSection label='Tags' initialState>
        <DriveTagList resource={drive} />
      </SettingsSection>
      <SettingsSection label='LLM Instructions' initialState>
        <p>
          A short description given to the AI Agent, use this to tell it what
          this drive is about, link important resources etc.
        </p>
        <ValueFormAddButton
          resource={drive}
          propertyURL={server.properties.llmTxt}
          datatype={Datatype.MARKDOWN}
          buttonLabel='Add LLM instructions'
        />
      </SettingsSection>
      <SettingsSection label='Default Ontology' initialState>
        <InputSwitcher
          commit
          resource={drive}
          property={defaultOntologyProp}
          disabled={!canEdit}
        />
      </SettingsSection>
      <SettingsSection label='Browser sync server' initialState>
        <Column gap='0.75rem'>
          <p>Server members meet through for free browser sync.</p>
          <InputSwitcher
            commit
            resource={drive}
            property={signalingUrlProp}
            disabled={!canEdit}
          />
        </Column>
      </SettingsSection>
      <ExternalAppList drive={drive.subject} />
      <SettingsSection label='Plugins' initialState>
        <Column gap='1rem'>
          <PluginList drive={drive} />
          {canEdit && (
            <Suspense fallback={null}>
              <NewPluginButton drive={drive} />
            </Suspense>
          )}
        </Column>
      </SettingsSection>
    </>
  );
}

/** Brings the Getting started card back after Hide; same flag, so they stay in sync. */
function GettingStartedSetting({
  drive,
  canEdit,
}: {
  drive: Resource;
  canEdit: boolean;
}): JSX.Element | null {
  const agent = useGettingStartedAgent(drive, canEdit);

  // Keyed by agent: the flag is read once, and the agent may load after mount.
  return agent ? <ShowGettingStarted key={agent} agent={agent} /> : null;
}

function ShowGettingStarted({ agent }: { agent: string }): JSX.Element {
  const [hidden, setHidden] = useLocalStorage(
    onboardingKeys.hidden(agent),
    false,
  );

  return (
    <SettingsSection label='Getting started' initialState>
      <SettingCheckbox
        checked={!hidden}
        onChange={checked => setHidden(!checked)}
      >
        Show Getting started on my drives
      </SettingCheckbox>
    </SettingsSection>
  );
}

function DriveTagList({ resource }: { resource: Resource }) {
  const canEdit = useCanWrite(resource);
  const navigate = useNavigateWithTransition();
  const [tags, setTags, pushTags] = useArray(
    resource,
    dataBrowser.properties.tagList,
    {
      commit: true,
    },
  );

  const handleDelete = (subject: string) => {
    setTags(tags.filter(t => t !== subject));
  };

  const handleNewTag = async (tag: Resource) => {
    await tag.save();
    pushTags([tag.subject]);
  };

  const handleTagClick =
    (subject: string): React.MouseEventHandler<HTMLAnchorElement> =>
    e => {
      e.preventDefault();
      navigate(constructOpenURL(subject));
    };

  if (tags.length === 0 && !canEdit) {
    return null;
  }

  return (
    <Column gap='0.75rem'>
      <Row gap='0.5rem' wrapItems>
        {tags.map(tag => (
          <TagItem key={tag}>
            <TagLink href={constructOpenURL(tag)} onClick={handleTagClick(tag)}>
              <Tag subject={tag} />
            </TagLink>
            {canEdit && (
              <DeleteTagButton
                type='button'
                title='Remove tag'
                onClick={() => handleDelete(tag)}
              >
                <FaXmark />
              </DeleteTagButton>
            )}
          </TagItem>
        ))}
      </Row>
      {canEdit && (
        <CreateTagRow parent={resource.subject} onNewTag={handleNewTag} />
      )}
    </Column>
  );
}

const TagItem = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.25ch;
`;

const TagLink = styled.a`
  text-decoration: none;
  display: contents;
`;

const DeleteTagButton = styled.button`
  display: inline-flex;
  align-items: center;
  padding: 0.2em;
  border: none;
  background: transparent;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  border-radius: ${p => p.theme.radius};
  opacity: 0;
  font-size: 0.75em;

  ${TagItem}:hover & {
    opacity: 1;
  }

  &:hover {
    color: ${p => p.theme.colors.alert};
  }

  @media (hover: none) {
    opacity: 1;
  }
`;
