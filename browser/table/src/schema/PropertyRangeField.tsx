import {
  useCallback,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
  type JSX,
} from 'react';

export interface PropertyRangeFieldProps {
  Input: ComponentType<
    InputHTMLAttributes<HTMLInputElement> & { $invalid?: boolean }
  >;
  Container: ComponentType<{ children: ReactNode }>;
  minValue?: number;
  maxValue?: number;
  round?: boolean;
  invalid?: boolean;
  onBlur?: () => void;
  onChange: (min: number | undefined, max: number | undefined) => void;
}

const toOptionalNum = (value: string, round: boolean): number | undefined => {
  const num = Number.parseFloat(value);

  if (Number.isNaN(num)) {
    return undefined;
  }

  return round ? Math.floor(num) : num;
};

export function validatePropertyRange(
  min: number | undefined,
  max: number | undefined,
  shouldBeRounded = false,
  messages = {
    rounded: 'Value should be a round number.',
    order: 'Min must be a less than max',
  },
): string | undefined {
  let error: string | undefined = undefined;

  if (min !== undefined && shouldBeRounded) {
    error = Number.isInteger(min) ? undefined : messages.rounded;
  }

  if (max !== undefined && shouldBeRounded) {
    error = Number.isInteger(min) ? undefined : messages.rounded;
  }

  if (min !== undefined && max !== undefined) {
    error = min < max ? undefined : messages.order;
  }

  return error;
}

export function PropertyRangeField({
  Input,
  Container,
  round = false,
  minValue,
  maxValue,
  invalid,
  onBlur,
  onChange,
}: PropertyRangeFieldProps): JSX.Element {
  const handleMinChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const num = toOptionalNum(e.target.value, round);
      onChange(num, maxValue);
    },
    [onChange, maxValue, round],
  );

  const handleMaxChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const num = toOptionalNum(e.target.value, round);
      onChange(minValue, num);
    },
    [onChange, minValue, round],
  );

  return (
    <Container>
      <Input
        $invalid={invalid}
        type='number'
        max={maxValue}
        placeholder='min'
        defaultValue={minValue}
        onBlur={onBlur}
        onChange={handleMinChange}
      />
      {' - '}
      <Input
        $invalid={invalid}
        type='number'
        placeholder='max'
        min={minValue}
        defaultValue={maxValue}
        onBlur={onBlur}
        onChange={handleMaxChange}
      />
    </Container>
  );
}
