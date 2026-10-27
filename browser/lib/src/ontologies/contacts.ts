/* -----------------------------------
 * Hand-maintained, in the shape @tomic/cli generates.
 *
 * The `contacts` ontology is defined in `lib/defaults/contacts.json` and
 * bootstrapped by every server, but it is not published on atomicdata.dev, so
 * `ad-generate ontologies` cannot produce this file. Keep it in sync with the
 * JSON by hand until it is published.
 * -------------------------------- */

import type { OntologyBaseObject, BaseProps } from '../index.js';

export const contacts = {
  classes: {
    contact: 'https://atomicdata.dev/classes/Contact',
  },
  properties: {
    email: 'https://atomicdata.dev/properties/email',
    invitedTo: 'https://atomicdata.dev/properties/invitedTo',
    invitedRole: 'https://atomicdata.dev/properties/invitedRole',
    invitedAt: 'https://atomicdata.dev/properties/invitedAt',
  },
  __classDefs: {
    ['https://atomicdata.dev/classes/Contact']: [
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/properties/email',
      'https://atomicdata.dev/properties/invitedTo',
      'https://atomicdata.dev/properties/invitedRole',
      'https://atomicdata.dev/properties/invitedAt',
    ],
  },
} as const satisfies OntologyBaseObject;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Contacts {
  export type Contact = typeof contacts.classes.contact;
}

declare module '../index.js' {
  interface Classes {
    [contacts.classes.contact]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/name'
        | typeof contacts.properties.email;
      recommends:
        | typeof contacts.properties.invitedTo
        | typeof contacts.properties.invitedRole
        | typeof contacts.properties.invitedAt;
    };
  }

  interface PropTypeMapping {
    [contacts.properties.email]: string;
    [contacts.properties.invitedTo]: string;
    [contacts.properties.invitedRole]: string;
    [contacts.properties.invitedAt]: number;
  }

  interface PropSubjectToNameMapping {
    [contacts.properties.email]: 'email';
    [contacts.properties.invitedTo]: 'invitedTo';
    [contacts.properties.invitedRole]: 'invitedRole';
    [contacts.properties.invitedAt]: 'invitedAt';
  }
}
