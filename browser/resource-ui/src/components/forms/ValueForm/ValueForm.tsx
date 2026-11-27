import { resourceTheme } from '../../../theme.js';
import { useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { FaPencil } from 'react-icons/fa6';
import { css, styled } from 'styled-components';
import {
  useProperty,
  useValue,
  Datatype,
  Resource,
  useCanWrite,
} from '@tomic/react';
import ValueComp from '../../ValueComp.js';
import { useSettings } from '../../../ResourceUIHost.js';
import { ValueFormEdit } from './ValueFormEdit.js';
import { useAIChanges } from '../../AIChangesContext.js';
import {
  ChangeSwitcher,
  isPropEqual,
} from '../../ResourceDiff/ResourceDiff.js';

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
  /** The id the input gets while editing, for a `<label htmlFor>` outside. */
  inputId?: string;
  /** Fit the value on one line while not editing. See `ValueComp`. */
  oneLine?: boolean;
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
  inputId,
  oneLine,
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
    // An unset value: for writers, show a click-to-edit placeholder that fills
    // the cell (so empty recommended properties are fillable, not just blank);
    // for everyone else there's nothing to show.
    if (!shouldShowEditButton) {
      return null;
    }

    return (
      <EmptyValue
        type='button'
        title='Click to add a value'
        onClick={() => handleEditModeChange(true)}
      >
        Click to set {property.shortname}
      </EmptyValue>
    );
  }

  if (!editMode) {
    // The whole value is the edit target, like a cell in a spreadsheet. Links,
    // buttons and selecting text keep working: those clicks are left alone.
    const handleValueClick = (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;

      if (
        target.closest('a, button, input, summary') ||
        window.getSelection()?.toString()
      ) {
        return;
      }

      handleEditModeChange(true);
    };

    return (
      <ValueFormWrapper
        $editable={shouldShowEditButton}
        onClick={shouldShowEditButton ? handleValueClick : undefined}
      >
        <ValueSlot>
          {valueChangedByAi ? (
            <ChangeSwitcher
              showFullValue
              property={property}
              oldResource={oldResource}
              newResource={resource}
            />
          ) : (
            <ValueComp
              value={value}
              datatype={datatype || property.datatype}
              oneLine={oneLine}
            />
          )}
        </ValueSlot>
        {shouldShowEditButton && (
          <EditButton
            type='button'
            title='Edit value'
            aria-label={`Edit ${property.shortname}`}
            onClick={() => handleEditModeChange(true)}
          >
            <FaPencil aria-hidden />
          </EditButton>
        )}
      </ValueFormWrapper>
    );
  }

  return (
    <ValueFormEdit
      resource={resource}
      property={property}
      inputId={inputId}
      onClose={() => handleEditModeChange(false)}
    />
  );
}

const EditButton = styled.button`
  appearance: none;
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0 0.2rem;
  line-height: inherit;
  color: ${p => resourceTheme(p.theme).colors.textLight};
  cursor: pointer;
  /* Touch screens have no hover: there the pencil stays visible. */
  opacity: 0.5;

  @media (hover: hover) and (pointer: fine) {
    opacity: 0;
  }

  &:hover,
  &:focus-visible {
    opacity: 1;
    color: ${p => resourceTheme(p.theme).colors.main};
  }
`;

const ValueSlot = styled.div`
  flex: 1;
  min-width: 0;
`;

/** Lights up on hover when the value can be edited, the way a cell does. */
const ValueFormWrapper = styled.div<{ $editable: boolean }>`
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
  flex: 1;
  width: calc(100% + 0.8rem);
  min-width: 0;
  word-wrap: break-word;
  padding: 0.1rem 0.4rem;
  margin: -0.1rem -0.4rem;
  border-radius: ${p => resourceTheme(p.theme).radius};

  ${p =>
    p.$editable &&
    css`
      cursor: pointer;

      /* Touch keeps :hover after a tap: light up only with a real hover. */
      @media (hover: hover) {
        &:hover {
          background-color: ${resourceTheme(p.theme).colors.bg1};
        }

        &:hover ${EditButton} {
          opacity: 1;
        }
      }
    `}
`;

const EmptyValue = styled.button`
  appearance: none;
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.1rem 0.4rem;
  margin: -0.1rem -0.4rem;
  border: none;
  border-radius: ${p => resourceTheme(p.theme).radius};
  background: none;
  color: ${p => resourceTheme(p.theme).colors.textLight};
  font-style: italic;
  cursor: text;

  &:hover,
  &:focus-visible {
    background-color: ${p => resourceTheme(p.theme).colors.bg1};
    color: ${p => resourceTheme(p.theme).colors.text};
  }
`;
