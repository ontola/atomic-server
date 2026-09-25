import { JSONValue } from '@tomic/react';
import { UNPARSED } from './useCommittedText';

/** What a number cell's editor may start from when typed on (#1825). */
export const integerSeed = /^[-\d]$/;
export const floatSeed = /^[-.\d]$/;

export const formatNumberInput = (value: JSONValue): string =>
  typeof value === 'number' && Number.isFinite(value) ? `${value}` : '';

/** Whole text only: `12abc` is not 12, and `1.5` is not 1. */
export function parseInteger(
  text: string,
): number | undefined | typeof UNPARSED {
  const trimmed = text.trim();

  if (trimmed === '') {
    return undefined;
  }

  if (!/^-?\d+$/.test(trimmed)) {
    return UNPARSED;
  }

  const num = Number.parseInt(trimmed, 10);

  return Number.isSafeInteger(num) ? num : UNPARSED;
}

/** Whole text only; a decimal comma reads as a point. */
export function parseFloatText(
  text: string,
): number | undefined | typeof UNPARSED {
  const trimmed = text.trim().replace(',', '.');

  if (trimmed === '') {
    return undefined;
  }

  if (!/^-?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) {
    return UNPARSED;
  }

  const num = Number.parseFloat(trimmed);

  return Number.isFinite(num) ? num : UNPARSED;
}
