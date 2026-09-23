// @wc-ignore-file
import { getIntegrationProxy } from '@helpers/integrationProxy';
import { savedConnectionKey } from '../../../../../integrations/localthought/settings';
import { type Store } from '@tomic/react';

export const platformName = (id: string) =>
  id
    .split(/[-_]/)
    .filter(Boolean)
    .map(word => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
import { BrowserIntegrations } from '../../../../../integrations/localthought/browser';
import { PlatformReader } from '../../../../../integrations/localthought/reflector-read';

/** OAuth/PKCE and the rotating-code proxy call; the credential stays inside. */
export const browserIntegrations = (origin = getIntegrationProxy()) =>
  new BrowserIntegrations(localStorage, origin);
/**
 * Setup description and one-way import, read from the proxy's catalog
 * document on the reflector path (atomic-plugins#52): no WASM engine.
 */
export const platformReader = (origin = getIntegrationProxy()) =>
  new PlatformReader(browserIntegrations(origin));
export async function proxyRequest<T>(
  store: Store,
  action: string,
  body: {
    origin?: string;
    drive: string;
    platform?: string;
    returnUrl?: string;
    state?: string;
    connectionCode?: string;
  },
): Promise<T> {
  const actor = store.getAgent()?.subject;
  if (!actor) throw new Error('Sign in before connecting an account');
  const client = browserIntegrations(body.origin);
  if (action === 'start')
    return (await client.start(
      body.drive,
      actor,
      body.platform!,
      body.returnUrl!,
    )) as T;
  if (action === 'finish')
    return (await client.finish(
      body.drive,
      actor,
      body.state!,
      body.connectionCode!,
    )) as T;
  throw new Error('Unknown browser integration action');
}
export interface SavedConnection {
  connection: string;
  platform: string;
  drive: string;
  actor: string;
}
export const connectionKey = (
  drive: string,
  actor: string,
  platform: string,
  origin = getIntegrationProxy(),
) => savedConnectionKey(origin, drive, actor, platform);
