/* -----------------------------------
 * Hand-maintained, in the shape @tomic/cli generates.
 *
 * The `notifications` ontology is defined in `lib/defaults/notifications.json`
 * and bootstrapped by every server, but its Ontology resource does not exist on
 * atomicdata.dev, so `ad-generate ontologies` cannot produce this file. Keep it
 * in sync with `lib/defaults/notifications.json` by hand until published.
 * -------------------------------- */

import type { OntologyBaseObject, BaseProps, JSONValue } from '../index.js';

export const notifications = {
  classes: {
    notificationItem: 'https://atomicdata.dev/classes/NotificationItem',
    watchSubscription: 'https://atomicdata.dev/classes/WatchSubscription',
    notificationPreferences:
      'https://atomicdata.dev/classes/NotificationPreferences',
    devicePushToken: 'https://atomicdata.dev/classes/DevicePushToken',
    directMessage: 'https://atomicdata.dev/classes/DirectMessage',
    accessRequest: 'https://atomicdata.dev/classes/AccessRequest',
  },
  properties: {
    mentions: 'https://atomicdata.dev/properties/mentions',
    notificationType: 'https://atomicdata.dev/properties/notificationType',
    mentionedAgent: 'https://atomicdata.dev/properties/mentionedAgent',
    watchTarget: 'https://atomicdata.dev/properties/watchTarget',
    watchKind: 'https://atomicdata.dev/properties/watchKind',
    notificationChannels:
      'https://atomicdata.dev/properties/notificationChannels',
    mutedUntil: 'https://atomicdata.dev/properties/mutedUntil',
    notificationEnabled:
      'https://atomicdata.dev/properties/notificationEnabled',
    notificationRead: 'https://atomicdata.dev/properties/notificationRead',
    dismissed: 'https://atomicdata.dev/properties/dismissed',
    notificationSummary:
      'https://atomicdata.dev/properties/notificationSummary',
    notificationActor: 'https://atomicdata.dev/properties/notificationActor',
    dedupeKey: 'https://atomicdata.dev/properties/dedupeKey',
    devicePushAgent: 'https://atomicdata.dev/properties/devicePushAgent',
    pushPlatform: 'https://atomicdata.dev/properties/pushPlatform',
    pushToken: 'https://atomicdata.dev/properties/pushToken',
    pushAppId: 'https://atomicdata.dev/properties/pushAppId',
    pushTokenUpdatedAt: 'https://atomicdata.dev/properties/pushTokenUpdatedAt',
    requestedRight: 'https://atomicdata.dev/properties/requestedRight',
    accessRequestStatus:
      'https://atomicdata.dev/properties/accessRequestStatus',
  },
  __classDefs: {
    ['https://atomicdata.dev/classes/NotificationItem']: [
      'https://atomicdata.dev/properties/notificationType',
      'https://atomicdata.dev/properties/about',
      'https://atomicdata.dev/properties/dedupeKey',
    ],
    ['https://atomicdata.dev/classes/WatchSubscription']: [
      'https://atomicdata.dev/properties/watchTarget',
    ],
    ['https://atomicdata.dev/classes/NotificationPreferences']: [],
    ['https://atomicdata.dev/classes/DevicePushToken']: [
      'https://atomicdata.dev/properties/devicePushAgent',
      'https://atomicdata.dev/properties/pushPlatform',
      'https://atomicdata.dev/properties/pushToken',
    ],
    ['https://atomicdata.dev/classes/DirectMessage']: [
      'https://atomicdata.dev/properties/description',
      'https://atomicdata.dev/properties/mentions',
    ],
    ['https://atomicdata.dev/classes/AccessRequest']: [
      'https://atomicdata.dev/properties/about',
      'https://atomicdata.dev/properties/mentions',
      'https://atomicdata.dev/properties/requestedRight',
    ],
  },
} as const satisfies OntologyBaseObject;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Notifications {
  export type NotificationItem = typeof notifications.classes.notificationItem;
  export type WatchSubscription =
    typeof notifications.classes.watchSubscription;
  export type NotificationPreferences =
    typeof notifications.classes.notificationPreferences;
  export type DevicePushToken = typeof notifications.classes.devicePushToken;
  export type DirectMessage = typeof notifications.classes.directMessage;
  export type AccessRequest = typeof notifications.classes.accessRequest;
}

declare module '../index.js' {
  interface Classes {
    [notifications.classes.notificationItem]: {
      requires:
        | BaseProps
        | typeof notifications.properties.notificationType
        | 'https://atomicdata.dev/properties/about'
        | typeof notifications.properties.dedupeKey;
      recommends:
        | typeof notifications.properties.notificationActor
        | typeof notifications.properties.mentionedAgent
        | typeof notifications.properties.watchTarget
        | typeof notifications.properties.notificationRead
        | typeof notifications.properties.dismissed
        | typeof notifications.properties.notificationSummary
        | typeof notifications.properties.requestedRight
        | 'https://atomicdata.dev/properties/name';
    };
    [notifications.classes.watchSubscription]: {
      requires: BaseProps | typeof notifications.properties.watchTarget;
      recommends:
        | typeof notifications.properties.watchKind
        | typeof notifications.properties.notificationChannels
        | typeof notifications.properties.mutedUntil
        | typeof notifications.properties.notificationEnabled
        | 'https://atomicdata.dev/properties/name';
    };
    [notifications.classes.notificationPreferences]: {
      requires: BaseProps;
      recommends:
        | typeof notifications.properties.notificationEnabled
        | typeof notifications.properties.notificationChannels
        | 'https://atomicdata.dev/properties/name';
    };
    [notifications.classes.devicePushToken]: {
      requires:
        | BaseProps
        | typeof notifications.properties.devicePushAgent
        | typeof notifications.properties.pushPlatform
        | typeof notifications.properties.pushToken;
      recommends:
        | typeof notifications.properties.pushAppId
        | typeof notifications.properties.pushTokenUpdatedAt
        | 'https://atomicdata.dev/properties/name';
    };
    [notifications.classes.directMessage]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/description'
        | typeof notifications.properties.mentions;
      recommends: 'https://atomicdata.dev/properties/name';
    };
    [notifications.classes.accessRequest]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/about'
        | typeof notifications.properties.mentions
        | typeof notifications.properties.requestedRight;
      recommends:
        | 'https://atomicdata.dev/properties/description'
        | typeof notifications.properties.accessRequestStatus
        | 'https://atomicdata.dev/properties/name';
    };
  }

  interface PropTypeMapping {
    [notifications.properties.mentions]: string[];
    [notifications.properties.notificationType]: string;
    [notifications.properties.mentionedAgent]: string;
    [notifications.properties.watchTarget]: string;
    [notifications.properties.watchKind]: string;
    [notifications.properties.notificationChannels]: JSONValue;
    [notifications.properties.mutedUntil]: number;
    [notifications.properties.notificationEnabled]: boolean;
    [notifications.properties.notificationRead]: boolean;
    [notifications.properties.dismissed]: boolean;
    [notifications.properties.notificationSummary]: string;
    [notifications.properties.notificationActor]: string;
    [notifications.properties.dedupeKey]: string;
    [notifications.properties.devicePushAgent]: string;
    [notifications.properties.pushPlatform]: string;
    [notifications.properties.pushToken]: string;
    [notifications.properties.pushAppId]: string;
    [notifications.properties.pushTokenUpdatedAt]: number;
    [notifications.properties.requestedRight]: string;
    [notifications.properties.accessRequestStatus]: string;
  }

  interface PropSubjectToNameMapping {
    [notifications.properties.mentions]: 'mentions';
    [notifications.properties.notificationType]: 'notificationType';
    [notifications.properties.mentionedAgent]: 'mentionedAgent';
    [notifications.properties.watchTarget]: 'watchTarget';
    [notifications.properties.watchKind]: 'watchKind';
    [notifications.properties.notificationChannels]: 'notificationChannels';
    [notifications.properties.mutedUntil]: 'mutedUntil';
    [notifications.properties.notificationEnabled]: 'notificationEnabled';
    [notifications.properties.notificationRead]: 'notificationRead';
    [notifications.properties.dismissed]: 'dismissed';
    [notifications.properties.notificationSummary]: 'notificationSummary';
    [notifications.properties.notificationActor]: 'notificationActor';
    [notifications.properties.dedupeKey]: 'dedupeKey';
    [notifications.properties.devicePushAgent]: 'devicePushAgent';
    [notifications.properties.pushPlatform]: 'pushPlatform';
    [notifications.properties.pushToken]: 'pushToken';
    [notifications.properties.pushAppId]: 'pushAppId';
    [notifications.properties.pushTokenUpdatedAt]: 'pushTokenUpdatedAt';
    [notifications.properties.requestedRight]: 'requestedRight';
    [notifications.properties.accessRequestStatus]: 'accessRequestStatus';
  }
}
