/* -----------------------------------
 * Hand-maintained, in the shape @tomic/cli generates.
 *
 * The `notifications` ontology is defined in `lib/defaults/notifications.json`
 * and bootstrapped by every server, but its Ontology resource does not exist on
 * atomicdata.dev, so `ad-generate ontologies` cannot produce this file. Keep it
 * in sync with `lib/defaults/notifications.json` by hand until it is published.
 * -------------------------------- */

import type { OntologyBaseObject, BaseProps, JSONValue } from '../index.js';

export const notifications = {
  classes: {
    inbox: 'https://atomicdata.dev/classes/Inbox',
    notification: 'https://atomicdata.dev/classes/Notification',
    follow: 'https://atomicdata.dev/classes/Follow',
    pushRegistration: 'https://atomicdata.dev/classes/PushRegistration',
    announcement: 'https://atomicdata.dev/classes/Announcement',
  },
  properties: {
    inbox: 'https://atomicdata.dev/properties/inbox',
    notificationSource: 'https://atomicdata.dev/properties/notificationSource',
    notificationKind: 'https://atomicdata.dev/properties/notificationKind',
    actor: 'https://atomicdata.dev/properties/actor',
    occurredAt: 'https://atomicdata.dev/properties/occurredAt',
    readAt: 'https://atomicdata.dev/properties/readAt',
    followLevel: 'https://atomicdata.dev/properties/followLevel',
    followClasses: 'https://atomicdata.dev/properties/followClasses',
    followProperties: 'https://atomicdata.dev/properties/followProperties',
    recipients: 'https://atomicdata.dev/properties/recipients',
    actionRequired: 'https://atomicdata.dev/properties/actionRequired',
    notificationCount: 'https://atomicdata.dev/properties/notificationCount',
    changedProperties: 'https://atomicdata.dev/properties/changedProperties',
    notifyEmail: 'https://atomicdata.dev/properties/notifyEmail',
    emailFrequency: 'https://atomicdata.dev/properties/emailFrequency',
    mutedNotificationKinds:
      'https://atomicdata.dev/properties/mutedNotificationKinds',
    notifyLanguage: 'https://atomicdata.dev/properties/notifyLanguage',
    pushEndpoint: 'https://atomicdata.dev/properties/pushEndpoint',
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
    ['https://atomicdata.dev/classes/Follow']: [
      'https://atomicdata.dev/properties/about',
      'https://atomicdata.dev/properties/followLevel',
      'https://atomicdata.dev/properties/followClasses',
      'https://atomicdata.dev/properties/followProperties',
    ],
    ['https://atomicdata.dev/classes/PushRegistration']: [
      'https://atomicdata.dev/properties/pushEndpoint',
      'https://atomicdata.dev/properties/name',
    ],
    ['https://atomicdata.dev/classes/Announcement']: [
      'https://atomicdata.dev/properties/recipients',
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/properties/description',
      'https://atomicdata.dev/properties/about',
      'https://atomicdata.dev/properties/actionRequired',
    ],
  },
} as const satisfies OntologyBaseObject;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Notifications {
  export type Inbox = typeof notifications.classes.inbox;
  export type Notification = typeof notifications.classes.notification;
  export type Follow = typeof notifications.classes.follow;
  export type PushRegistration = typeof notifications.classes.pushRegistration;
  export type Announcement = typeof notifications.classes.announcement;
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
    [notifications.classes.follow]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/about';
      recommends:
        | typeof notifications.properties.followLevel
        | typeof notifications.properties.followClasses
        | typeof notifications.properties.followProperties;
    };
    [notifications.classes.pushRegistration]: {
      requires: BaseProps | typeof notifications.properties.pushEndpoint;
      recommends: 'https://atomicdata.dev/properties/name';
    };
    [notifications.classes.announcement]: {
      requires: BaseProps | typeof notifications.properties.recipients;
      recommends:
        | 'https://atomicdata.dev/properties/name'
        | 'https://atomicdata.dev/properties/description'
        | 'https://atomicdata.dev/properties/about'
        | typeof notifications.properties.actionRequired;
    };
  }

  interface PropTypeMapping {
    [notifications.properties.inbox]: string;
    [notifications.properties.notificationSource]: string;
    [notifications.properties.notificationKind]: string;
    [notifications.properties.actor]: string;
    [notifications.properties.occurredAt]: number;
    [notifications.properties.readAt]: number;
    [notifications.properties.followLevel]: string;
    [notifications.properties.followClasses]: string[];
    [notifications.properties.followProperties]: string[];
    [notifications.properties.recipients]: string[];
    [notifications.properties.actionRequired]: boolean;
    [notifications.properties.notificationCount]: number;
    [notifications.properties.changedProperties]: string[];
    [notifications.properties.notifyEmail]: string;
    [notifications.properties.emailFrequency]: string;
    [notifications.properties.mutedNotificationKinds]: JSONValue;
    [notifications.properties.notifyLanguage]: string;
    [notifications.properties.pushEndpoint]: string;
  }

  interface PropSubjectToNameMapping {
    [notifications.properties.inbox]: 'inbox';
    [notifications.properties.notificationSource]: 'notificationSource';
    [notifications.properties.notificationKind]: 'notificationKind';
    [notifications.properties.actor]: 'actor';
    [notifications.properties.occurredAt]: 'occurredAt';
    [notifications.properties.readAt]: 'readAt';
    [notifications.properties.followLevel]: 'followLevel';
    [notifications.properties.followClasses]: 'followClasses';
    [notifications.properties.followProperties]: 'followProperties';
    [notifications.properties.recipients]: 'recipients';
    [notifications.properties.actionRequired]: 'actionRequired';
    [notifications.properties.notificationCount]: 'notificationCount';
    [notifications.properties.changedProperties]: 'changedProperties';
    [notifications.properties.notifyEmail]: 'notifyEmail';
    [notifications.properties.emailFrequency]: 'emailFrequency';
    [notifications.properties.mutedNotificationKinds]: 'mutedNotificationKinds';
    [notifications.properties.notifyLanguage]: 'notifyLanguage';
    [notifications.properties.pushEndpoint]: 'pushEndpoint';
  }
}
