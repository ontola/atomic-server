import { useId } from 'react';
import { Column } from '@components/Row';
import Field from '@components/forms/Field';
import { Checkbox } from '@components/forms/Checkbox';
import { BasicSelect } from '@components/forms/BasicSelect';
import { Input } from '@components/forms/InputStyles';
import {
  asConfigObject,
  fieldError,
  type ConfigField,
  type ConfigObject,
} from './configFormLogic';

interface ConfigFormProps {
  fields: ConfigField[];
  config: unknown;
  onChange: (config: ConfigObject) => void;
  disabled?: boolean;
}

/** One labelled input per field of a flat config schema. */
export const ConfigForm: React.FC<ConfigFormProps> = ({
  fields,
  config,
  onChange,
  disabled,
}) => {
  const id = useId();
  const values = asConfigObject(config);

  const set = (key: string, value: string | number | boolean | undefined) => {
    const next = { ...values };

    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <Column>
      {fields.map(field => {
        const { key, def, type, required } = field;
        const value = values[key];
        const message = fieldError(field, value);
        const fieldId = `${id}-${key}`;
        const common = { id: fieldId, disabled };

        return (
          <Field
            key={key}
            label={def.title ?? key}
            fieldId={fieldId}
            required={required}
            helper={def.description}
            helperAlwaysVisible
            error={message ? new Error(message) : undefined}
          >
            {def.enum ? (
              <BasicSelect
                {...common}
                value={String(value ?? '')}
                onChange={e => {
                  const picked = def.enum!.find(
                    o => String(o) === e.target.value,
                  );
                  set(key, picked as string | number | boolean | undefined);
                }}
              >
                <option value=''>-</option>
                {def.enum.map(o => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </BasicSelect>
            ) : type === 'boolean' ? (
              <Checkbox
                {...common}
                checked={value === true}
                onChange={checked => set(key, checked)}
              />
            ) : type === 'string' ? (
              <Input
                {...common}
                value={typeof value === 'string' ? value : ''}
                onChange={e => set(key, e.target.value)}
              />
            ) : (
              <Input
                {...common}
                type='number'
                value={typeof value === 'number' ? value : ''}
                onChange={e =>
                  set(
                    key,
                    e.target.value === '' ? undefined : e.target.valueAsNumber,
                  )
                }
              />
            )}
          </Field>
        );
      })}
    </Column>
  );
};
