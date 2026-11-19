import { core } from '@tomic/react';
import AllProps from '@tomic/resource-ui/components/AllProps';
import { ClassDetail } from '../components/ClassDetail';
import { ContainerNarrow } from '@tomic/ui/components/Containers';
import { ValueForm } from '@tomic/resource-ui/components/forms/ValueForm/index';
import { NewInstanceButton } from '../components/NewInstanceButton';
import { Title } from '@tomic/resource-ui/components/Title';
import { Column, Row } from '@tomic/ui/components/Row';
import { ResourcePageProps } from './ResourcePage';
import { defaultHiddenProps } from './ResourcePageDefault';

/**
 * Full page Class resoure that features a New instance button, and a Typescript
 * definition export.
 */
export function ClassPage({ resource }: ResourcePageProps) {
  return (
    <ContainerNarrow about={resource.subject}>
      <Column>
        <Title resource={resource} />
        <ClassDetail resource={resource} />
        <ValueForm
          resource={resource}
          propertyURL={core.properties.description}
        />
        <AllProps
          resource={resource}
          except={defaultHiddenProps}
          editable
          columns
        />
        <Row>
          <NewInstanceButton icon={true} klass={resource.subject} />
        </Row>
      </Column>
    </ContainerNarrow>
  );
}
