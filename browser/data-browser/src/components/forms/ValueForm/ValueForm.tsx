import { useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { FaPencil } from 'react-icons/fa6';
import { styled } from 'styled-components';
import {
  useProperty,
  useValue,
  Datatype,
  Resource,
  useCanWrite,
} from '@tomic/react';
import ValueComp from '../../ValueComp';
import { useSettings } from '../../../helpers/AppSettings';
import { ValueFormEdit } from './ValueFormEdit';
import { useAIChanges } from '@components/AIChangesContext';
import {
  ChangeSwitcher,
  isPropEqual,
} from '@components/ResourceDiff/ResourceDiff';

interface ValueFormProps {
  // Maybe pass Value instead of Resource?
  resource: Resource;
  propertyURL: string;
  /**
   * The datatype is automatically determined using the propertyUrl, but you can
   * also override it manually
   */
  datatype?: Datatype;
  /** Whether the form should start in edit mode when mounted. */
  defaultEditState?: boolean;
  onStateChange?: (editMode: boolean) => void;
}

/**
 * A form for a single Value. Presents a normal value, but let's the user click
 * on a button to turn it into an input.
 */
export function ValueForm({
  resource,
  propertyURL,
  datatype,
  defaultEditState = false,
  onStateChange,
}: ValueFormProps) {
  const { changes, oldResources } = useAIChanges();
  const hasAiChanges = changes.includes(resource.subject);
  const oldResource = oldResources[resource.subject];
  const valueChangedByAi =
    hasAiChanges &&
    oldResource !== undefined &&
    !isPropEqual(oldResource.get(propertyURL), resource.get(propertyURL));

  const [editMode, setEditMode] = useState(defaultEditState);
  const property = useProperty(propertyURL);
  const [value] = useValue(resource, propertyURL);
  const { agent } = useSettings();
  const canWrite = useCanWrite(resource);

  const handleEditModeChange = (state: boolean) => {
    setEditMode(state);
    onStateChange?.(state);
  };

  useHotkeys(
    'esc',
    () => {
      handleEditModeChange(false);
    },
    {
      enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'],
    },
  );

  const hasAgent = agent !== undefined;

  const shouldShowEditButton = hasAgent && canWrite && !property.isDynamic;

  if (!property && !datatype) {
    return <span title={`loading ${propertyURL}...`}>...</span>;
  }

  if (value === undefined && !editMode) {
    return null;
  }

  if (!editMode) {
    return (
      <ValueFormWrapper>
        {valueChangedByAi ? (
          <ChangeSwitcher
            showFullValue
            property={property}
            oldResource={oldResource}
            newResource={resource}
          />
        ) : (
          <ValueComp value={value} datatype={datatype || property.datatype} />
        )}
        {shouldShowEditButton && (
          <EditButton title='Edit value'>
            <FaPencil onClick={() => handleEditModeChange(!editMode)} />
          </EditButton>
        )}
      </ValueFormWrapper>
    );
  }

  return (
    <ValueFormEdit
      resource={resource}
      property={property}
      onClose={() => handleEditModeChange(false)}
    />
  );
}

const ValueFormWrapper = styled.div`
  /* Used for positioning the edit button*/
  position: relative;
  flex: 1;
  word-wrap: break-word;
  width: 100%;
`;

const EditButton = styled.button`
  appearance: none;
  background: none;
  border: none;
  position: absolute;
  top: 0;
  color: ${p => p.theme.colors.main};
  right: 100%;
  cursor: pointer;
  opacity: 0;

  /** Only show hover edit button on mouse devices, prevents having to tap twice on some mobile devices */
  @media (hover: hover) and (pointer: fine) {
    ${ValueFormWrapper}:hover & {
      opacity: 0.5;
      &:hover {
        opacity: 1;
      }
    }
  }
`;
