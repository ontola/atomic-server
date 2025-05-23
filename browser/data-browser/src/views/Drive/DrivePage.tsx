import {
  Datatype,
  core,
  server,
  dataBrowser,
  useProperty,
  useCanWrite,
  useArray,
  type Resource,
  type Server,
} from '@tomic/react';
import { ContainerNarrow } from '@components/Containers';
import { ValueForm } from '@components/forms/ValueForm';
import { Button } from '@components/Button';
import { useSettings } from '@helpers/AppSettings';
import { ResourcePageProps } from '../ResourcePage';
import { EditableTitle } from '@components/EditableTitle';
import { Column, Row } from '@components/Row';
import { styled } from 'styled-components';
import InputSwitcher from '@components/forms/InputSwitcher';
import { WarningBlock } from '@components/WarningBlock';
import { Details } from '@components/Details';

import { lazy, Suspense, type JSX } from 'react';
import { PluginList } from './PluginList';
import { Tag } from '@components/Tag/Tag';
import { CreateTagRow } from '@components/Tag/CreateTagRow';
import { constructOpenURL } from '@helpers/navigation';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { FaXmark } from 'react-icons/fa6';

const NewPluginButton = lazy(() => import('@chunks/Plugins/NewPluginButton'));

/** A View for Drives, which function similar to a homepage or dashboard. */
function DrivePage({ resource }: ResourcePageProps<Server.Drive>): JSX.Element {
  const { drive: baseURL, setDrive: setBaseURL } = useSettings();

  const defaultOntologyProp = useProperty(server.properties.defaultOntology);
  const canEdit = useCanWrite(resource);

  if (!baseURL) {
    setBaseURL(resource.subject);
  }

  return (
    <ContainerNarrow>
      <Column gap='2rem'>
        <Row>
          <EditableTitle resource={resource} />
          {baseURL !== resource.subject && (
            <Button onClick={() => setBaseURL(resource.subject)}>
              Set as current drive
            </Button>
          )}
        </Row>
        {baseURL.startsWith('http://localhost') && (
          <WarningBlock>
            You are running Atomic-Server on `localhost`, which means that it
            will not be available from any other machine than your current local
            device. If you want your Atomic-Server to be available from the web,
            you should set this up at a Domain on a server.
          </WarningBlock>
        )}
        <ValueForm
          resource={resource}
          propertyURL={core.properties.description}
          datatype={Datatype.MARKDOWN}
        />
        <SettingsArea>
          <SettingsSection>
            <Details noIndent title={<SettingsLabel>Tags</SettingsLabel>}>
              <SettingsContent>
                <DriveTagList resource={resource} />
              </SettingsContent>
            </Details>
          </SettingsSection>
          <SettingsSection>
            <Details
              noIndent
              title={<SettingsLabel>Default Ontology</SettingsLabel>}
            >
              <SettingsContent>
                <InputSwitcher
                  commit
                  resource={resource}
                  property={defaultOntologyProp}
                  disabled={!canEdit}
                />
              </SettingsContent>
            </Details>
          </SettingsSection>
          <SettingsSection>
            <Details noIndent title={<SettingsLabel>Plugins</SettingsLabel>}>
              <SettingsContent>
                <Column gap='1rem'>
                  <PluginList drive={resource} />
                  {canEdit && (
                    <Suspense fallback={null}>
                      <NewPluginButton drive={resource} />
                    </Suspense>
                  )}
                </Column>
              </SettingsContent>
            </Details>
          </SettingsSection>
        </SettingsArea>
      </Column>
    </ContainerNarrow>
  );
}

function DriveTagList({ resource }: { resource: Resource }) {
  const canEdit = useCanWrite(resource);
  const navigate = useNavigateWithTransition();
  const [tags, setTags] = useArray(resource, dataBrowser.properties.tagList, {
    commit: true,
  });

  const handleDelete = (subject: string) => {
    setTags(tags.filter(t => t !== subject));
  };

  const handleNewTag = async (tag: Resource) => {
    await tag.save();
    setTags([...tags, tag.subject]);
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

export default DrivePage;

const SettingsArea = styled.div`
  border-top: 1px solid ${p => p.theme.colors.bg2};

  /* Tone down the Details toggle button for this context */
  button[aria-label='collapse'],
  button[aria-label='expand'] {
    height: 1.5em;
    background: transparent !important;
    box-shadow: none !important;
  }
`;

const SettingsSection = styled.div`
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  padding-block: 0.4rem;
`;

const SettingsLabel = styled.span`
  font-size: 0.9rem;
  font-weight: 500;
  color: ${p => p.theme.colors.textLight};
`;

const SettingsContent = styled.div`
  padding-block: 0.5rem 0.25rem;
`;

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
`;
