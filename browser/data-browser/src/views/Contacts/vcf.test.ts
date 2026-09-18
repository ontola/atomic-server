import { describe, expect, it } from 'vitest';
import { parseVCardDocument, unfoldVCard } from './vcf';

const googleStyle = `BEGIN:VCARD
VERSION:3.0
N:Doe;Jane;;;
FN:Jane Doe
ORG:Acme Inc.
TITLE:Engineer
EMAIL;TYPE=INTERNET;TYPE=WORK:jane@acme.com
EMAIL;TYPE=INTERNET;TYPE=HOME:jane@example.com
TEL;TYPE=CELL:+1-555-0100
TEL;TYPE=WORK:+1-555-0199
ADR;TYPE=WORK:;;123 Main St;Springfield;IL;62701;USA
URL:https://example.com/jane
NOTE:Met at the conference.
UID:google-contact-uid-1
END:VCARD
`;

const appleFolded = `BEGIN:VCARD
VERSION:3.0
N:Smith;Alex;;;
FN:Alex Smith
EMAIL;type=INTERNET;type=HOME;type=pref:alex@icloud.com
NOTE:Line one\\nLine two
ITEM1.URL;type=pref:https://example.com/a
UID:urn:uuid:apple-uid-42
END:VCARD
`;

const outlookMulti = `BEGIN:VCARD
VERSION:3.0
FN:Bob Builder
N:Builder;Bob;;;
ORG:Build Co
TEL;WORK;VOICE:555-1000
EMAIL;PREF;INTERNET:bob@build.co
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Carol
EMAIL:carol@example.org
END:VCARD
`;

describe('unfoldVCard', () => {
  it('joins folded lines', () => {
    expect(unfoldVCard('NOTE:hello\r\n world')).toBe('NOTE:helloworld');
  });
});

describe('parseVCardDocument', () => {
  it('parses a Google-style contact', () => {
    const [card] = parseVCardDocument(googleStyle);
    expect(card).toMatchObject({
      name: 'Jane Doe',
      givenName: 'Jane',
      familyName: 'Doe',
      organization: 'Acme Inc.',
      jobTitle: 'Engineer',
      email: 'jane@acme.com',
      telephone: '+1-555-0100',
      website: 'https://example.com/jane',
      notes: 'Met at the conference.',
      uid: 'google-contact-uid-1',
    });
    expect(card.emails).toHaveLength(2);
    expect(card.telephones).toHaveLength(2);
    expect(card.addresses[0]).toMatchObject({
      street: '123 Main St',
      locality: 'Springfield',
      region: 'IL',
      postalCode: '62701',
      country: 'USA',
    });
  });

  it('parses an Apple-style contact with UID and note escapes', () => {
    const [card] = parseVCardDocument(appleFolded);
    expect(card.name).toBe('Alex Smith');
    expect(card.email).toBe('alex@icloud.com');
    expect(card.notes).toBe('Line one\nLine two');
    expect(card.uid).toBe('urn:uuid:apple-uid-42');
    expect(card.website).toBe('https://example.com/a');
  });

  it('parses multiple Outlook-style cards', () => {
    const cards = parseVCardDocument(outlookMulti);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      name: 'Bob Builder',
      organization: 'Build Co',
      email: 'bob@build.co',
      telephone: '555-1000',
    });
    expect(cards[1].name).toBe('Carol');
    expect(cards[1].email).toBe('carol@example.org');
  });

  it('skips empty cards', () => {
    expect(
      parseVCardDocument('BEGIN:VCARD\nVERSION:3.0\nEND:VCARD'),
    ).toHaveLength(0);
  });
});
