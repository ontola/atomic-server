import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCamt053, parseXml } from './camt053';
import { parseBankStatement } from './statement';
import { run } from './plugin';
const fixture = readFileSync(
  new URL('./fixtures/synthetic.camt053.xml', import.meta.url),
  'utf8',
);
const mt940Fixture = readFileSync(
  new URL('./fixtures/synthetic.mt940', import.meta.url),
  'utf8',
);
const p = Object.fromEntries(
  [
    'account',
    'currency',
    'amount',
    'value-date',
    'booking-date',
    'description',
    'reference',
    'transaction-code',
    'statement',
    'source-id',
    'fingerprint',
  ].map(k => [`bank-${k}`, `https://example.com/${k}`]),
);
const host = {
  text: fixture,
  config: {
    table: 'https://example.com/table',
    rowClass: 'https://example.com/transaction',
    properties: p,
  },
  query: () => [] as string[],
  read: () => ({}),
};
describe('camt.053 parser and import proposals', () => {
  it('reads namespaced, prefixed and self-closing XML with entities and CDATA', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!-- c --><ns:A x="1" y=\'&amp;\'><ns:B/><C><![CDATA[<raw>]]>&#65;</C></ns:A>',
    );
    const a = root.children[0];
    expect(a.name).toBe('A');
    expect(a.attrs).toEqual({ x: '1', y: '&' });
    expect(a.children.map(c => c.name)).toEqual(['B', 'C']);
    expect(a.children[1].text).toBe('<raw>A');
    expect(() => parseXml('<A><B></A>')).toThrow('mismatched');
    expect(() => parseXml('<A>')).toThrow('unclosed');
  });
  it('maps booked entries to exact amounts, dates, codes, references and narratives', () => {
    const [statement] = parseCamt053(fixture);
    expect(statement).toMatchObject({
      account: 'NL00BUNQ0000000000',
      number: 'SYNTHETIC-1',
      currency: 'EUR',
      opening: '100',
      closing: '107.66',
      start: '2026-09-01',
      end: '2026-09-03',
    });
    expect(statement.transactions).toEqual([
      {
        date: '2026-09-02',
        bookingDate: '2026-09-02',
        amount: '-12.34',
        code: 'PMNT/ICDT/ESCT',
        reference: '1',
        bankReference: 'TEST-1',
        description:
          'Fixture Café & Bar NL00TEST0000000001\nFixture lunch\nSecond line',
      },
      {
        date: '2026-09-03',
        bookingDate: '2026-09-03',
        amount: '20',
        code: 'REFUND',
        reference: 'E2E-2',
        bankReference: 'TEST-2',
        description: 'Fixture Shop\nRefund\nBooked refund',
      },
    ]);
  });
  it('accepts v08 status codes, DtTm dates, PRCD openings and Othr account ids', () => {
    const sample = fixture
      .replace(/<Sts>BOOK<\/Sts>/g, '<Sts><Cd>BOOK</Cd></Sts>')
      .replace('<Sts>PDNG</Sts>', '<Sts><Cd>PDNG</Cd></Sts>')
      .replace(
        '<Dt><Dt>2026-09-01</Dt></Dt>',
        '<Dt><DtTm>2026-09-01T00:00:00+02:00</DtTm></Dt>',
      )
      .replace('<Cd>OPBD</Cd>', '<Cd>PRCD</Cd>')
      .replace(
        '<IBAN>NL00BUNQ0000000000</IBAN>',
        '<Othr><Id>123456789</Id></Othr>',
      );
    const [statement] = parseCamt053(sample);
    expect(statement.account).toBe('123456789');
    expect(statement.start).toBe('2026-09-01');
    expect(statement.transactions).toHaveLength(2);
  });
  it('rejects wrong balances, foreign currencies, bad dates, non-statements and oversized files', () => {
    for (const [invalid, message] of [
      [fixture.replace('107.66', '107.67'), 'reconcile'],
      [
        fixture.replace('<Amt Ccy="EUR">12.34', '<Amt Ccy="USD">12.34'),
        'currency',
      ],
      [
        fixture.replace(
          '2026-09-02</Dt></BookgDt>',
          '2026-02-30</Dt></BookgDt>',
        ),
        'date',
      ],
      [fixture.replace('<Cd>CLBD</Cd>', '<Cd>ITBD</Cd>'), 'CLBD'],
      ['<Document><BkToCstmrAcctRpt/></Document>', 'BkToCstmrStmt'],
      ['<'.padEnd(1_000_001, ' '), '1 MB'],
    ] as const)
      expect(() => parseCamt053(invalid)).toThrow(message);
  });
  it('bounds the transaction count', () => {
    const entry = fixture.slice(
      fixture.indexOf('<Ntry>'),
      fixture.indexOf('</Ntry>') + '</Ntry>'.length,
    );
    const many = fixture.replace(entry, entry.repeat(501));
    expect(() => parseCamt053(many)).toThrow('500');
  });
  it('detects the format and keeps camt.053 identities apart from MT940 ones', () => {
    expect(parseBankStatement(mt940Fixture).format).toBe('mt940');
    expect(parseBankStatement('﻿\n' + fixture).format).toBe('camt053');
    const verdict = run(host);
    expect(verdict.intents).toHaveLength(2);
    const first = verdict.intents[0] as any;
    expect(first.set[p['bank-amount']]).toBe('-12.34');
    expect(first.set[p['bank-source-id']]).toBe(
      JSON.stringify([
        'camt053',
        'NL00BUNQ0000000000',
        'EUR',
        ['bank', 'TEST-1'],
      ]),
    );
    expect(first.set[p['bank-fingerprint']]).toMatch(/^camt053-content:/);
    expect(
      (run({ ...host, text: mt940Fixture }).intents[0] as any).set[
        p['bank-source-id']
      ],
    ).toBe(
      JSON.stringify([
        'mt940',
        'NL00BUNQ0000000000',
        'EUR',
        ['bank', 'TEST-1'],
      ]),
    );
  });
});
