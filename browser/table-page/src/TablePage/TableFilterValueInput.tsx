import { Datatype, Property, server } from '@tomic/react';
import { useLayoutEffect, useRef, type JSX } from 'react';
import { ResourceSelector } from '@tomic/resource-ui/components/forms/ResourceSelector/index';
import { BasicSelect } from '@tomic/ui/components/forms/BasicSelect';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import { TagOption } from './RowActionDialog.js';
import { canonicalJson } from './canonicalJson.js';

interface TableFilterValueInputProps {
  property: Property;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Atomic's index compares canonical numeric strings. Other hosts can keep
   * their exact query literal until their own parser validates it. */
  normalizeNumbers?: boolean;
}

/**
 * Datatype-aware editor for a single filter value. References and resource
 * arrays use the resource search box; everything else gets a fitting plain
 * input. The value is always serialised to a string (matching the query
 * param + `contains_value`'s string comparison).
 */
export function TableFilterValueInput({
  property,
  value,
  onChange,
  autoFocus,
  disabled,
  normalizeNumbers = false,
}: TableFilterValueInputProps): JSX.Element {
  const datatype = property.datatype;
  const disabledRef = useRef(disabled);
  useLayoutEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);
  const numeric = datatype === Datatype.INTEGER || datatype === Datatype.FLOAT;

  const change = (next: string) => {
    if (!disabledRef.current) onChange(next);
  };

  // A select column only holds its own options, so offer exactly those rather
  // than a search over every tag in the drive.
  if (property.allowsOnly?.length) {
    return (
      <BasicSelect
        aria-label='Filter value'
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={e => change(e.target.value)}
      >
        <option value=''>Pick an option…</option>
        {value && !property.allowsOnly.includes(value) && (
          <option value={value} disabled>
            {value}
          </option>
        )}
        {property.allowsOnly.map(tag => (
          <TagOption key={tag} subject={tag} />
        ))}
      </BasicSelect>
    );
  }

  if (datatype === Datatype.ATOMIC_URL || datatype === Datatype.RESOURCEARRAY) {
    return (
      <ResourceSelector
        value={value || undefined}
        isA={
          property.classType === server.classes.file
            ? undefined
            : property.classType
        }
        hideCreateOption
        autoFocus={autoFocus}
        disabled={disabled}
        setSubject={subject => change(subject ?? '')}
      />
    );
  }

  if (datatype === Datatype.BOOLEAN) {
    return (
      <BasicSelect
        aria-label='Filter value'
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={e => change(e.target.value)}
      >
        {value && !['true', 'false'].includes(value) && (
          <option value={value} disabled>
            {value}
          </option>
        )}
        <option value=''>Any</option>
        <option value='true'>True</option>
        <option value='false'>False</option>
      </BasicSelect>
    );
  }

  // Native number inputs erase incomplete literals such as `1e` before React
  // sees them. Keep the query draft as text and offer a numeric keyboard.
  const inputType = datatype === Datatype.DATE ? 'date' : 'text';

  return (
    <InputWrapper>
      <InputStyled
        aria-label='Filter value'
        type={inputType}
        inputMode={numeric ? 'decimal' : undefined}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder='Value…'
        onChange={e => change(e.target.value)}
        onBlur={() => {
          if (disabled || value.trim() === '') return;

          // A JSON value is indexed with its keys sorted and no whitespace, so
          // `{"b":2,"a":1}` would match nothing though a row stores exactly that.
          if (datatype === Datatype.JSON && value !== '') {
            const canonical = canonicalJson(value);

            if (canonical !== undefined && canonical !== value) {
              change(canonical);
            }
          }

          // The index compares the text of a stored number, so "2.5e-5" and
          // "0.00002500" would match nothing though they equal a stored 0.000025.
          if (numeric && normalizeNumbers) {
            const number = Number(value);

            if (
              Number.isFinite(number) &&
              !(Number.isInteger(number) && !Number.isSafeInteger(number)) &&
              String(number) !== value
            ) {
              change(String(number));
            }
          }
        }}
      />
    </InputWrapper>
  );
}
