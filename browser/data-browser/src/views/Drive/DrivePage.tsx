import {
  Datatype,
  core,
  server,
  useProperty,
  useCanWrite,
  useStore,
  type Resource,
  type Server,
  useArray,
  dataBrowser,
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
import { SettingsGroup, SettingsSection } from '@components/Settings';

import { lazy, Suspense, useEffect, useState, type JSX } from 'react';
import { PluginList } from './PluginList';
import { Tag } from '@components/Tag/Tag';
import { CreateTagRow } from '@components/Tag/CreateTagRow';
import { constructOpenURL } from '@helpers/navigation';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { FaXmark } from 'react-icons/fa6';
import { QuickCreateRow } from '@components/NewInstanceButton';
import { ResourceSideBar } from '@components/SideBar/ResourceSideBar/ResourceSideBar';
import { ScrollArea } from '@components/ScrollArea';
import { useChildren } from '@tomic/react';

const NewPluginButton = lazy(() => import('@chunks/Plugins/NewPluginButton'));

/** A View for Drives, which function similar to a homepage or dashboard. */
function DrivePage({ resource }: ResourcePageProps<Server.Drive>): JSX.Element {
  const { drive: baseURL, setDrive: setBaseURL } = useSettings();
  const store = useStore();
  const { subjects: subResources } = useChildren(resource.subject);
  const [ancestry, setAncestry] = useState<string[]>([]);

  useEffect(() => {
    store.getResourceAncestry(resource).then(result => {
      setAncestry(result);
    });
  }, [store, resource]);

  const defaultOntologyProp = useProperty(server.properties.defaultOntology);
  const canEdit = useCanWrite(resource);

  if (!baseURL) {
    setBaseURL(resource.subject);
  }

  return (
    <ContainerNarrow>
      <Column gap='2rem'>
        <Row wrapItems gap='1rem'>
          <EditableTitle resource={resource} />
          {baseURL !== resource.subject && (
            <Button onClick={() => setBaseURL(resource.subject)}>
              Set as current drive
            </Button>
          )}
        </Row>
        <ValueForm
          resource={resource}
          propertyURL={core.properties.description}
          datatype={Datatype.MARKDOWN}
        />
        {canEdit && <QuickCreateRow parent={resource.subject} />}

        <DriveSubResourcesSection>
          <ScrollArea>
            {subResources.map((child, index) => (
              <ResourceSideBar
                key={child}
                subject={child}
                renderedHierarchy={[resource.subject]}
                ancestry={ancestry}
              />
            ))}
          </ScrollArea>
        </DriveSubResourcesSection>

        <SettingsGroup>
          <SettingsSection label='Tags'>
            <DriveTagList resource={resource} />
          </SettingsSection>
          <SettingsSection label='Default Ontology'>
            <InputSwitcher
              commit
              resource={resource}
              property={defaultOntologyProp}
              disabled={!canEdit}
            />
          </SettingsSection>
          <SettingsSection label='Plugins'>
            <Column gap='1rem'>
              <PluginList drive={resource} />
              {canEdit && (
                <Suspense fallback={null}>
                  <NewPluginButton drive={resource} />
                </Suspense>
              )}
            </Column>
          </SettingsSection>
        </SettingsGroup>
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

const DriveSubResourcesSection = styled.div`
  margin-top: 1rem;
`;
