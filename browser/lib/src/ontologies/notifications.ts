/* -----------------------------------
 * Hand-maintained, in the shape @tomic/cli generates.
 *
 * The `notifications` ontology is defined in `lib/defaults/notifications.json`
 * and bootstrapped by every server, but its Ontology resource does not exist on
 * atomicdata.dev, so `ad-generate ontologies` cannot produce this file. Keep it
 * in sync with `lib/defaults/notifications.json` by hand until it is published.
 * -------------------------------- */

import type { OntologyBaseObject, BaseProps } from '../index.js';

export const notifications = {
  classes: {
    inbox: 'https://atomicdata.dev/classes/Inbox',
    notification: 'https://atomicdata.dev/classes/Notification',
  },
  properties: {
    inbox: 'https://atomicdata.dev/properties/inbox',
    notificationSource: 'https://atomicdata.dev/properties/notificationSource',
    notificationKind: 'https://atomicdata.dev/properties/notificationKind',
    actor: 'https://atomicdata.dev/properties/actor',
    occurredAt: 'https://atomicdata.dev/properties/occurredAt',
    readAt: 'https://atomicdata.dev/properties/readAt',
  },
  __classDefs: {
    ['https://atomicdata.dev/classes/Inbox']: [
      'https://atomicdata.dev/properties/name',
    ],
    ['https://atomicdata.dev/classes/Notification']: [
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/properties/notificationSource',
      'https://atomicdata.dev/properties/description',
      'https://atomicdata.dev/properties/about',
      'https://atomicdata.dev/properties/notificationKind',
      'https://atomicdata.dev/properties/actor',
      'https://atomicdata.dev/properties/occurredAt',
      'https://atomicdata.dev/properties/readAt',
    ],
  },
} as const satisfies OntologyBaseObject;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Notifications {
  export type Inbox = typeof notifications.classes.inbox;
  export type Notification = typeof notifications.classes.notification;
}

declare module '../index.js' {
  interface Classes {
    [notifications.classes.inbox]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/name';
      recommends: never;
    };
    [notifications.classes.notification]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/name'
        | typeof notifications.properties.notificationSource;
      recommends:
        | 'https://atomicdata.dev/properties/description'
        | 'https://atomicdata.dev/properties/about'
        | typeof notifications.properties.notificationKind
        | typeof notifications.properties.actor
        | typeof notifications.properties.occurredAt
        | typeof notifications.properties.readAt;
    };
  }

  interface PropTypeMapping {
    [notifications.properties.inbox]: string;
    [notifications.properties.notificationSource]: string;
    [notifications.properties.notificationKind]: string;
    [notifications.properties.actor]: string;
    [notifications.properties.occurredAt]: number;
    [notifications.properties.readAt]: number;
  }

  interface PropSubjectToNameMapping {
    [notifications.properties.inbox]: 'inbox';
    [notifications.properties.notificationSource]: 'notificationSource';
    [notifications.properties.notificationKind]: 'notificationKind';
    [notifications.properties.actor]: 'actor';
    [notifications.properties.occurredAt]: 'occurredAt';
    [notifications.properties.readAt]: 'readAt';
  }
}
