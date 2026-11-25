import { useCallback, type JSX } from 'react';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import { Row } from '@tomic/ui/components/Row';

interface MinMaxInputProps {
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

export function validateRange(
  min: number | undefined,
  max: number | undefined,
  shouldBeRounded = false,
): string | undefined {
  if (
    shouldBeRounded &&
    ((min !== undefined && !Number.isInteger(min)) ||
      (max !== undefined && !Number.isInteger(max)))
  ) {
    return 'Value should be a round number.';
  }

  if (min !== undefined && max !== undefined && min >= max) {
    return 'Min must be a less than max';
  }

  return undefined;
}

export function MinMaxInput({
  round = false,
  minValue,
  maxValue,
  invalid,
  onBlur,
  onChange,
}: MinMaxInputProps): JSX.Element {
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
    <Row center gap='0.5rem'>
      <InputWrapper $invalid={invalid}>
        <InputStyled
          type='number'
          step={round ? 1 : 'any'}
          max={maxValue}
          placeholder='min'
          defaultValue={minValue}
          onBlur={onBlur}
          onChange={handleMinChange}
        />
      </InputWrapper>
      {' - '}
      <InputWrapper $invalid={invalid}>
        <InputStyled
          type='number'
          step={round ? 1 : 'any'}
          placeholder='max'
          min={minValue}
          defaultValue={maxValue}
          onBlur={onBlur}
          onChange={handleMaxChange}
        />
      </InputWrapper>
    </Row>
  );
}
