import { JSONValue, Property, useResource, useStore } from '@tomic/react';
import { useEffect, useId, useMemo, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { ConfirmationDialog } from '@components/ConfirmationDialog';
import { BasicSelect } from '@components/forms/BasicSelect';
import InputSwitcher from '@components/forms/InputSwitcher';

interface TableSetPropertyDialogProps {
  /** Properties the user can choose to set (the view's columns). */
  properties: Property[];
  /** Number of rows the value will be written to. */
  count: number;
  show: boolean;
  bindShow: (show: boolean) => void;
  /** Writes `value` to `propertySubject` on every selected row. */
  onApply: (propertySubject: string, value: JSONValue | undefined) => void;
}

/**
 * Bulk "set property" editor: pick one of the view's columns and a value, then
 * write it to every selected row. The value is captured on a throwaway
 * in-memory resource so we can reuse the normal per-datatype inputs
 * (`InputSwitcher`) and read the typed value back on confirm.
 */
export function TableSetPropertyDialog({
  properties,
  count,
  show,
  bindShow,
  onApply,
}: TableSetPropertyDialogProps): JSX.Element | null {
  const store = useStore();
  const propertySelectId = useId();
  const valueInputId = useId();
  // A throwaway subject to hold the value being entered. Never saved.
  const [scratchSubject] = useState(() => store.createSubject());
  const scratch = useResource(scratchSubject);

  const [selectedSubject, setSelectedSubject] = useState<string>(
    properties[0]?.subject ?? '',
  );

  // Keep the selection valid if the column set changes while open.
  useEffect(() => {
    if (
      properties.length > 0 &&
      !properties.some(p => p.subject === selectedSubject)
    ) {
      setSelectedSubject(properties[0].subject);
    }
  }, [properties, selectedSubject]);

  const selectedProperty = useMemo(
    () => properties.find(p => p.subject === selectedSubject),
    [properties, selectedSubject],
  );

  if (properties.length === 0) {
    return null;
  }

  const handleConfirm = () => {
    if (!selectedProperty) {
      return;
    }

    onApply(selectedProperty.subject, scratch.get(selectedProperty.subject));
  };

  return (
    <ConfirmationDialog
      title={`Set a property on ${count} ${count === 1 ? 'row' : 'rows'}`}
      confirmLabel='Apply'
      show={show}
      bindShow={bindShow}
      onConfirm={handleConfirm}
    >
      <Fields>
        <Field>
          <label htmlFor={propertySelectId}>Property</label>
          <BasicSelect
            id={propertySelectId}
            data-testid='bulk-set-property-select'
            value={selectedSubject}
            onChange={e => setSelectedSubject(e.target.value)}
          >
            {properties.map(property => (
              <option key={property.subject} value={property.subject}>
                {property.shortname}
              </option>
            ))}
          </BasicSelect>
        </Field>
        {selectedProperty && (
          <Field>
            <label htmlFor={valueInputId}>Value</label>
            <InputSwitcher
              // Remount the input when the property changes so it binds to the
              // new datatype and starts empty.
              key={selectedProperty.subject}
              id={valueInputId}
              resource={scratch}
              property={selectedProperty}
            />
          </Field>
        )}
      </Fields>
    </ConfirmationDialog>
  );
}

const Fields = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;

  & > label {
    color: ${p => p.theme.colors.textLight};
  }
`;
