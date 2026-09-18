// @wc-ignore-file
import { parseCamt053 } from './camt053.js';
import { parseMT940, type Statement } from './parser.js';

export type StatementFormat = 'mt940' | 'camt053';

// XML is camt.053; anything else is handed to the MT940 reader, whose own
// errors explain an unrecognised file.
export function detectStatementFormat(text: string): StatementFormat {
  return text.replace(/^﻿/, '').trimStart().startsWith('<')
    ? 'camt053'
    : 'mt940';
}

export function parseBankStatement(text: string): {
  format: StatementFormat;
  statements: Statement[];
} {
  if (typeof text !== 'string') throw new Error('Choose a bank statement file');
  const format = detectStatementFormat(text);
  return {
    format,
    statements: format === 'camt053' ? parseCamt053(text) : parseMT940(text),
  };
}
