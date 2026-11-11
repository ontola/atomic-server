// @wc-ignore-file
import { nativeHostOf, type NativeClientDb, type Store } from '@tomic/react';

/**
 * Why an app cannot do something in a page that has no server (the embedded
 * renderer): connecting an integration needs the proxy, which only a server
 * reaches.
 *
 * Writing as the app and holding its key do work there: the device's host
 * does them (`NativeClientDb.appWrite` / `setAppAgent`).
 */
export const NO_SERVER_APP_MESSAGE =
  'Connecting an integration needs a server, and this page has none (it is the embedded app).';

/**
 * The device host behind a `noServer` store, which signs and stores an app's
 * writes and key. Throws when the store's database is not the native one.
 */
export function noServerHost(
  store: Pick<Store, 'getClientDb'>,
): NativeClientDb {
  const host = nativeHostOf(store);

  if (!host) throw new Error('This page has no device host to act as the app.');

  return host;
}
