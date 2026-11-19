import {
  core,
  useCanWrite,
  useProperty,
  useResource,
  type Resource,
} from '@tomic/react';

import { styled } from 'styled-components';
import InputSwitcher from '@tomic/resource-ui/components/forms/InputSwitcher';
import { Row } from '@tomic/ui/components/Row';
import InputString from '@tomic/resource-ui/components/forms/InputString';
import { PropertyDatatypePicker } from '../PropertyDatatypePicker';
import { IconButton } from '@tomic/ui/components/IconButton/IconButton';
import { FaSliders, FaXmark } from 'react-icons/fa6';
import { useDialog } from '@tomic/resource-ui/components/Dialog/index';
import { PropertyWriteDialog } from './PropertyWriteDialog';
import { useOntologyContext } from '../OntologyContext';
import { ErrorLook } from '@tomic/resource-ui/components/ErrorLook';
import { Button } from '@tomic/ui/components/Button';
import { isContentAddressed } from '@tomic/resource-ui/helpers/propertyIdentity';
import { ClassConstraintEditor } from '../Class/ClassConstraintEditor';

import type { JSX } from 'react';

interface PropertyLineWriteProps {
  subject: string;
  onRemove: (subject: string) => void;
  /** The class this line belongs to. Its constraints for the property are editable under the line. */
  classResource?: Resource;
}

export function PropertyLineWrite({
  subject,
  onRemove,
  classResource,
}: PropertyLineWriteProps): JSX.Element {
  const resource = useResource(subject);
  const shortnameProp = useProperty(core.properties.shortname);
  const descriptionProp = useProperty(core.properties.description);
  const [dialogProps, show, hide, isOpen] = useDialog();
  const canEdit = useCanWrite(resource);

  const { hasProperty } = useOntologyContext();

  const disabled = !canEdit || !hasProperty(subject);

  if (resource.error) {
    return (
      <ListItem>
        <Row center justify='space-between'>
          <StyledErrorLook>
            This property does not exist any more ({subject})
          </StyledErrorLook>
          <Button alert onClick={() => onRemove(subject)}>
            Remove
          </Button>
        </Row>
      </ListItem>
    );
  }

  return (
    <ListItem>
      <Row center wrapItems>
        <InputSwitcher
          aria-label='Property shortname'
          commit
          required
          // The shortname is part of a content-addressed property's ID.
          disabled={disabled || isContentAddressed(subject)}
          resource={resource}
          property={shortnameProp}
        />
        <InputString
          aria-label='Property description'
          commit
          required
          disabled={disabled}
          resource={resource}
          property={descriptionProp}
        />
        <Row center>
          <PropertyDatatypePicker disabled={disabled} resource={resource} />
          <IconButton
            title={`Configure ${resource.title}`}
            color='textLight'
            onClick={show}
          >
            <FaSliders />
          </IconButton>
          <IconButton
            title='remove'
            color='textLight'
            onClick={() => onRemove(subject)}
          >
            <FaXmark />
          </IconButton>
        </Row>
      </Row>
      {classResource && (
        <ClassConstraintEditor
          classResource={classResource}
          propertySubject={subject}
        />
      )}
      <PropertyWriteDialog
        resource={resource}
        classResource={classResource}
        {...dialogProps}
        close={hide}
        isOpen={isOpen}
      />
    </ListItem>
  );
}

const ListItem = styled.li`
  margin-left: 0px;
  list-style: none;
`;

const StyledErrorLook = styled(ErrorLook)`
  max-lines: 2;
  overflow: hidden;
  flex: 1;
`;
