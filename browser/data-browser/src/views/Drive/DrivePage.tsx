import {
  Datatype,
  core,
  server,
  useProperty,
  useCanWrite,
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

import { type JSX } from 'react';
import { PluginList } from './PluginList';

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
        <div>
          <Heading>Default Ontology</Heading>
          <InputSwitcher
            commit
            resource={resource}
            property={defaultOntologyProp}
            disabled={!canEdit}
          />
        </div>
        <PluginList drive={resource} />
      </Column>
    </ContainerNarrow>
  );
}

export default DrivePage;

const Heading = styled.h2`
  /* font-size: 1.3rem; */
`;
