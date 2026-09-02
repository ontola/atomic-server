import { type JSX } from 'react';
import { styled } from 'styled-components';
import { Row } from '@components/Row';
import { InputStyled, InputWrapper } from './InputStyles';

export interface SliderInputProps {
  id?: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  numberAriaLabel?: string;
  /** Format the number field display (e.g. fixed decimal places). */
  formatValue?: (value: number) => string;
  suffix?: string;
  invalid?: boolean;
}

const parseStepValue = (raw: string, step: number): number => {
  const parsed =
    Number.isInteger(step) && step >= 1
      ? Number.parseInt(raw, 10)
      : Number.parseFloat(raw);

  return Number.isNaN(parsed) ? 0 : parsed;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function SliderInput({
  id,
  value,
  onChange,
  min,
  max,
  step,
  numberAriaLabel,
  formatValue,
  suffix,
  invalid,
}: SliderInputProps): JSX.Element {
  const displayValue = formatValue ? formatValue(value) : value;
  const progress = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <Row center fullWidth>
      <RangeInput
        id={id}
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        $progress={progress}
        onChange={e => onChange(parseStepValue(e.target.value, step))}
      />
      <EndAlignedInputWrapper $invalid={invalid}>
        <NumberInput
          type='number'
          min={min}
          max={max}
          step={step}
          value={displayValue}
          onChange={e =>
            onChange(clamp(parseStepValue(e.target.value, step), min, max))
          }
          aria-label={numberAriaLabel}
        />
        {suffix}
      </EndAlignedInputWrapper>
    </Row>
  );
}

const RangeInput = styled.input.attrs<{ $progress: number }>(p => ({
  style: { '--progress': `${p.$progress}%` } as Record<string, string>,
}))`
  --track-height: 0.25rem;
  --thumb-size: 1rem;
  flex: 1;
  flex-basis: 75%;
  margin: 0;
  height: var(--thumb-size);
  background: transparent;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: 2px;
    border-radius: ${p => p.theme.radius};
  }

  &::-webkit-slider-runnable-track {
    height: var(--track-height);
    border-radius: ${p => p.theme.radius};
    background: linear-gradient(
      to right,
      ${p => p.theme.colors.main} 0%,
      ${p => p.theme.colors.main} var(--progress),
      ${p => p.theme.colors.bg2} var(--progress),
      ${p => p.theme.colors.bg2} 100%
    );
  }

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: var(--thumb-size);
    height: var(--thumb-size);
    margin-top: calc((var(--thumb-size) - var(--track-height)) / -2);
    border-radius: 50%;
    background: ${p => p.theme.colors.main};
  }

  &:hover::-webkit-slider-thumb {
    background: ${p => p.theme.colors.mainLight};
  }

  &::-moz-range-track {
    height: var(--track-height);
    border-radius: ${p => p.theme.radius};
    background: ${p => p.theme.colors.bg2};
  }

  &::-moz-range-progress {
    height: var(--track-height);
    border-radius: ${p => p.theme.radius};
    background: ${p => p.theme.colors.main};
  }

  &::-moz-range-thumb {
    width: var(--thumb-size);
    height: var(--thumb-size);
    border-radius: 50%;
    background: ${p => p.theme.colors.main};
    cursor: pointer;
  }

  &:hover::-moz-range-thumb {
    background: ${p => p.theme.colors.mainLight};
  }
`;

const NumberInput = styled(InputStyled)`
  width: 4.5rem;
  flex: 0 0 auto;
  text-align: end;
  padding-inline-end: 0;
  &::-webkit-inner-spin-button,
  &::-webkit-outer-spin-button {
    -webkit-appearance: none;
    width: 0;
    margin: 0;
  }
`;

const EndAlignedInputWrapper = styled(InputWrapper)`
  justify-content: flex-end;
  padding-inline-end: ${p => p.theme.size(2)};
`;
