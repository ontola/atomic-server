/**
 * First-party vCard (VCF) parser for Google Contacts / iCloud / Microsoft
 * exports. Handles vCard 3.0 and the common 4.0 subset used by those apps.
 */

export type VCardTypedValue = {
  value: string;
  type?: string;
};

export type VCardAddress = {
  street?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  type?: string;
};

/** Normalized contact fields mapped from one BEGIN:VCARD … END:VCARD block. */
export type ParsedVCard = {
  name: string;
  givenName?: string;
  familyName?: string;
  organization?: string;
  jobTitle?: string;
  email?: string;
  telephone?: string;
  emails: VCardTypedValue[];
  telephones: VCardTypedValue[];
  addresses: VCardAddress[];
  website?: string;
  notes?: string;
  uid?: string;
};

/** Unfold RFC 6350 line continuations (CRLF/LF + space or tab). */
export function unfoldVCard(text: string): string {
  return text.replace(/\r\n[\t ]|\n[\t ]|\r[\t ]/g, '');
}

function splitLines(text: string): string[] {
  return unfoldVCard(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0);
}

type ParsedLine = {
  name: string;
  params: Record<string, string>;
  value: string;
};

/** Parse one content line into name / params / value (quoted-printable light). */
function parseLine(line: string): ParsedLine | undefined {
  const colon = line.indexOf(':');

  if (colon === -1) {
    return undefined;
  }

  const meta = line.slice(0, colon);
  let value = line.slice(colon + 1);
  const parts = meta.split(';');
  const name = (parts[0] ?? '').split('.').pop()?.toUpperCase() ?? '';
  const params: Record<string, string> = {};

  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');

    if (eq === -1) {
      // Bare TYPE-like tokens: `;WORK;VOICE`
      const key = part.toUpperCase();

      if (key) {
        params.TYPE = params.TYPE ? `${params.TYPE},${key}` : key;
      }

      continue;
    }

    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1).replace(/^"|"$/g, '');
    params[key] = params[key] ? `${params[key]},${val}` : val;
  }

  if (params.ENCODING?.toUpperCase() === 'QUOTED-PRINTABLE') {
    value = decodeQuotedPrintable(value);
  }

  value = unescapeVCardValue(value);

  return { name, params, value };
}

function unescapeVCardValue(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function firstType(params: Record<string, string>): string | undefined {
  const raw = params.TYPE ?? params.TYPE;

  if (!raw) {
    return undefined;
  }

  return raw.split(',')[0]?.toLowerCase();
}

function splitStructured(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;

  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === ';') {
      parts.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  parts.push(current);

  return parts;
}

function parseOneCard(lines: string[]): ParsedVCard | undefined {
  const emails: VCardTypedValue[] = [];
  const telephones: VCardTypedValue[] = [];
  const addresses: VCardAddress[] = [];
  let fn: string | undefined;
  let givenName: string | undefined;
  let familyName: string | undefined;
  let organization: string | undefined;
  let jobTitle: string | undefined;
  let website: string | undefined;
  let notes: string | undefined;
  let uid: string | undefined;

  for (const line of lines) {
    const parsed = parseLine(line);

    if (!parsed) {
      continue;
    }

    const { name, params, value } = parsed;

    switch (name) {
      case 'FN':
        fn = value.trim();
        break;
      case 'N': {
        const [family, given] = splitStructured(value);
        familyName = family?.trim() || undefined;
        givenName = given?.trim() || undefined;
        break;
      }
      case 'ORG':
        organization = splitStructured(value)[0]?.trim() || undefined;
        break;
      case 'TITLE':
        jobTitle = value.trim() || undefined;
        break;
      case 'EMAIL': {
        const email = value.trim();

        if (email) {
          emails.push({ value: email, type: firstType(params) });
        }

        break;
      }
      case 'TEL': {
        const tel = value.replace(/^tel:/i, '').trim();

        if (tel) {
          telephones.push({ value: tel, type: firstType(params) });
        }

        break;
      }
      case 'ADR': {
        const parts = splitStructured(value);
        // ADR: PO Box; Extended; Street; Locality; Region; PostalCode; Country
        const street = [parts[1], parts[2]].filter(Boolean).join('\n').trim();
        const address: VCardAddress = {
          street: street || undefined,
          locality: parts[3]?.trim() || undefined,
          region: parts[4]?.trim() || undefined,
          postalCode: parts[5]?.trim() || undefined,
          country: parts[6]?.trim() || undefined,
          type: firstType(params),
        };

        if (
          address.street ||
          address.locality ||
          address.region ||
          address.postalCode ||
          address.country
        ) {
          addresses.push(address);
        }

        break;
      }
      case 'URL':
        if (!website && value.trim()) {
          website = value.trim();
        }

        break;
      case 'NOTE':
        notes = value.trim() || undefined;
        break;
      case 'UID':
        uid = value.trim() || undefined;
        break;
      default:
        break;
    }
  }

  const name =
    fn ||
    [givenName, familyName].filter(Boolean).join(' ') ||
    organization ||
    emails[0]?.value ||
    telephones[0]?.value;

  if (!name) {
    return undefined;
  }

  return {
    name,
    givenName,
    familyName,
    organization,
    jobTitle,
    email: emails[0]?.value,
    telephone: telephones[0]?.value,
    emails,
    telephones,
    addresses,
    website,
    notes,
    uid,
  };
}

/** Parse a full `.vcf` document into zero or more contacts. */
export function parseVCardDocument(text: string): ParsedVCard[] {
  const lines = splitLines(text);
  const cards: ParsedVCard[] = [];
  let current: string[] | undefined;

  for (const line of lines) {
    const upper = line.toUpperCase();

    if (upper === 'BEGIN:VCARD') {
      current = [];
      continue;
    }

    if (upper === 'END:VCARD') {
      if (current) {
        const card = parseOneCard(current);

        if (card) {
          cards.push(card);
        }
      }

      current = undefined;
      continue;
    }

    if (current) {
      current.push(line);
    }
  }

  return cards;
}
