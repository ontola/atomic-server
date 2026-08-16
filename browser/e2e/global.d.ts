import type { Agent, NotificationEngine, Store } from '@tomic/lib';

declare global {
  interface Window {
    /** Set by data-browser `App.tsx` for debugging and e2e probes. */
    store: Store;
    /** Set by NotificationEngineProvider for e2e / console. */
    __notificationEngine?: NotificationEngine;
    /** Production helpers so e2e does not reimplement folder/drive lookup. */
    __notificationsHelpers?: {
      getOrCreateNotificationsFolder: (
        store: Store,
        drive: string,
      ) => Promise<string>;
      fetchPersonalDriveSubject: (
        store: Store,
        agent: Agent,
      ) => Promise<string | undefined>;
    };
  }
}

export {};
