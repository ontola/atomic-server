// @wc-ignore-file
// ISO 20022 camt.053 (BankToCustomerStatement) reader producing the same
// Statement shape as the MT940 parser. It runs in the plugin sandbox, which
// has no DOMParser, so it carries its own small XML reader.
import {
  decimal,
  rejectJsonNarratives,
  units,
  type Statement,
  type Transaction,
} from './parser.js';

export const CAMT053_MAX_BYTES = 5_000_000;

interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

const local = (name: string) => name.replace(/^[^:]*:/, '');

function decode(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    (_, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return String.fromCodePoint(
            entity[1] === 'x'
              ? parseInt(entity.slice(2), 16)
              : Number(entity.slice(1)),
          );
      }
    },
  );
}

function attributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(
    /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  ))
    attrs[local(match[1])] = decode(match[2] ?? match[3] ?? '');
  return attrs;
}

// Namespace prefixes are dropped: banks emit both `<Document>` and
// `<ns:Document>` for the same schema.
export function parseXml(source: string): Node {
  const root: Node = { name: '', attrs: {}, children: [], text: '' };
  const stack: Node[] = [root];
  const token =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
  let position = 0;
  while (position < source.length) {
    token.lastIndex = position;
    const match = token.exec(source);
    if (!match) throw new Error('Malformed camt.053 XML');
    position = token.lastIndex;
    const current = stack[stack.length - 1];
    if (match[1] !== undefined) current.text += match[1];
    else if (match[2] !== undefined) {
      if (stack.length < 2 || local(match[2]) !== current.name)
        throw new Error('Malformed camt.053 XML: mismatched closing tag');
      stack.pop();
    } else if (match[3] !== undefined) {
      const node: Node = {
        name: local(match[3]),
        attrs: attributes(match[4]),
        children: [],
        text: '',
      };
      current.children.push(node);
      if (!match[5]) stack.push(node);
    } else if (match[6] !== undefined) current.text += decode(match[6]);
  }
  if (stack.length !== 1)
    throw new Error('Malformed camt.053 XML: unclosed element');
  return root;
}

const all = (node: Node | undefined, name: string): Node[] =>
  node?.children.filter(child => child.name === name) ?? [];
function one(node: Node | undefined, ...path: string[]): Node | undefined {
  let current = node;
  for (const name of path) current = all(current, name)[0];
  return current;
}
const textOf = (node: Node | undefined, ...path: string[]): string =>
  one(node, ...path)?.text.trim() ?? '';

function isoDate(raw: string): string {
  const result = raw.slice(0, 10);
  const parsed = new Date(result + 'T00:00:00Z');
  if (
    !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(raw) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result
  )
    throw new Error('Invalid camt.053 date');
  return result;
}

// camt.053 amounts use a dot; MT940's `decimal` expects a comma.
function amount(node: Node | undefined, currency: string, negative: boolean) {
  const raw = node?.text.trim() ?? '';
  if (!node || !/^\d{1,15}(?:\.\d{0,5})?$/.test(raw))
    throw new Error('Invalid camt.053 amount');
  if (node.attrs.Ccy && node.attrs.Ccy !== currency)
    throw new Error(
      'camt.053 entry currency differs from the account currency',
    );
  return decimal(
    raw.includes('.') ? raw.replace('.', ',') : raw + ',',
    negative,
  );
}

function direction(node: Node | undefined): boolean {
  const indicator = textOf(node, 'CdtDbtInd');
  if (indicator !== 'CRDT' && indicator !== 'DBIT')
    throw new Error('Invalid camt.053 credit/debit indicator');
  return indicator === 'DBIT';
}

// `<Dt><Dt>` in most files; `<Dt><DtTm>` from some banks.
const dateOf = (node: Node | undefined, ...path: string[]) =>
  textOf(node, ...path, 'Dt') || textOf(node, ...path, 'DtTm');

function balance(node: Node, currency: string) {
  const type = textOf(node, 'Tp', 'CdOrPrtry', 'Cd');
  const raw = dateOf(node, 'Dt');
  if (!raw) throw new Error('camt.053 balance is missing its date');
  return {
    type,
    date: isoDate(raw),
    amount: amount(one(node, 'Amt'), currency, direction(node)),
  };
}

const partyName = (party: Node | undefined) =>
  textOf(party, 'Nm') || textOf(party, 'Pty', 'Nm');
const accountId = (account: Node | undefined) =>
  textOf(account, 'Id', 'IBAN') || textOf(account, 'Id', 'Othr', 'Id');

function transactionCode(entry: Node): string {
  const domain = one(entry, 'BkTxCd', 'Domn');
  const structured = [
    textOf(domain, 'Cd'),
    textOf(domain, 'Fmly', 'Cd'),
    textOf(domain, 'Fmly', 'SubFmlyCd'),
  ].filter(Boolean);
  return structured.length
    ? structured.join('/')
    : textOf(entry, 'BkTxCd', 'Prtry', 'Cd');
}

function transaction(entry: Node, currency: string): Transaction {
  const negative = direction(entry);
  const bookingRaw = dateOf(entry, 'BookgDt');
  const valueRaw = dateOf(entry, 'ValDt');
  if (!bookingRaw && !valueRaw)
    throw new Error('camt.053 entry has no booking or value date');
  const details = all(one(entry, 'NtryDtls'), 'TxDtls');
  const references = details.map(detail => one(detail, 'Refs'));
  const endToEnd = references
    .map(refs => textOf(refs, 'EndToEndId'))
    .find(value => value && value !== 'NOTPROVIDED');
  const lines: string[] = [];
  const add = (line: string) => {
    if (line && !lines.includes(line)) lines.push(line);
  };
  for (const detail of details) {
    const parties = one(detail, 'RltdPties');
    // The other side of the money: the creditor of a debit, the debtor of a credit.
    const counterparty = negative ? 'Cdtr' : 'Dbtr';
    add(
      [
        partyName(one(parties, counterparty)),
        accountId(one(parties, `${counterparty}Acct`)),
      ]
        .filter(Boolean)
        .join(' '),
    );
    const remittance = one(detail, 'RmtInf');
    for (const unstructured of all(remittance, 'Ustrd'))
      add(unstructured.text.trim());
    for (const structured of all(remittance, 'Strd'))
      add(textOf(structured, 'CdtrRefInf', 'Ref'));
    add(textOf(detail, 'AddtlTxInf'));
  }
  add(textOf(entry, 'AddtlNtryInf'));
  return {
    date: isoDate(valueRaw || bookingRaw),
    bookingDate: isoDate(bookingRaw || valueRaw),
    amount: amount(one(entry, 'Amt'), currency, negative),
    code: transactionCode(entry),
    reference: endToEnd || textOf(entry, 'NtryRef') || 'NONREF',
    bankReference:
      textOf(entry, 'AcctSvcrRef') ||
      references.map(refs => textOf(refs, 'AcctSvcrRef')).find(Boolean) ||
      '',
    description: lines.join('\n'),
  };
}

export function parseCamt053(text: string): Statement[] {
  if (typeof text !== 'string' || text.length > CAMT053_MAX_BYTES)
    throw new Error('Choose a camt.053 file smaller than 5 MB');
  const root = parseXml(text.replace(/^﻿/, ''));
  const report = one(root, 'Document', 'BkToCstmrStmt');
  if (!report)
    throw new Error(
      'Not a camt.053 bank statement: expected a Document with BkToCstmrStmt',
    );
  const statements: Statement[] = [];
  let count = 0;
  for (const stmt of all(report, 'Stmt')) {
    const acct = one(stmt, 'Acct');
    const account = accountId(acct);
    if (!account) throw new Error('Missing bank account');
    const balanceNodes = all(stmt, 'Bal');
    const currency =
      textOf(acct, 'Ccy') ||
      balanceNodes.map(node => one(node, 'Amt')?.attrs.Ccy).find(Boolean) ||
      '';
    if (!/^[A-Z]{3}$/.test(currency))
      throw new Error('Missing camt.053 account currency');
    const balances = balanceNodes.map(node => balance(node, currency));
    // PRCD (previously closed booked) stands in for OPBD at some banks.
    const opening =
      balances.find(b => b.type === 'OPBD') ??
      balances.find(b => b.type === 'PRCD');
    const closing = balances.find(b => b.type === 'CLBD');
    if (!opening || !closing)
      throw new Error(
        'camt.053 statement needs an opening (OPBD) and closing (CLBD) booked balance',
      );
    if (closing.date < opening.date)
      throw new Error('Statement currency or date range is inconsistent');
    const transactions: Transaction[] = [];
    for (const entry of all(stmt, 'Ntry')) {
      // Only booked entries move the booked balances; pending ones are left out.
      const status = textOf(entry, 'Sts') || textOf(entry, 'Sts', 'Cd');
      if (status && status !== 'BOOK') continue;
      if (++count > 500)
        throw new Error(
          'Import at most 500 transactions at a time; export a shorter period',
        );
      transactions.push(transaction(entry, currency));
    }
    if (
      units(opening.amount) +
        transactions.reduce((sum, row) => sum + units(row.amount), 0n) !==
      units(closing.amount)
    )
      throw new Error(
        'Statement balance does not reconcile; no transactions will be imported',
      );
    statements.push({
      account,
      number: textOf(stmt, 'Id') || textOf(stmt, 'ElctrncSeqNb'),
      currency,
      opening: opening.amount,
      closing: closing.amount,
      start: opening.date,
      end: closing.date,
      transactions,
    });
  }
  if (!statements.length)
    throw new Error('camt.053 file contains no statements');
  rejectJsonNarratives(statements);
  return statements;
}
