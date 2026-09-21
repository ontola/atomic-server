import { useEffect, useRef, useState } from 'react';
import { useStore } from '@tomic/react';
import { ErrMessage } from '@components/forms/InputStyles';
import { useIntegrationProxy } from '@helpers/integrationProxy';
import {
  browserIntegrations,
  connectionKey,
  proxyRequest,
} from './localThought';

export interface PendingLocalThoughtConnection {
  state: string;
  drive: string;
  actor: string;
  platform: string;
  origin?: string;
  entry?: string;
}

export interface LocalThoughtCallbackData {
  state: string;
  code?: string;
  platform?: string;
  error?: string;
}

export function callbackEntry(pending: PendingLocalThoughtConnection) {
  return (
    pending.entry ??
    (pending.platform === 'notion' ? 'notion' : `proxy:${pending.platform}`)
  );
}

export function completedPlatformForEntry(
  completed: unknown,
  {
    drive,
    actor,
    origin,
    entry,
  }: {
    drive: string | undefined;
    actor: string | undefined;
    origin: string;
    entry: string;
  },
) {
  if (!completed || typeof completed !== 'object') return undefined;
  const value = completed as Record<string, unknown>;

  return value.drive === drive &&
    value.actor === actor &&
    value.origin === origin &&
    value.entry === entry &&
    typeof value.platform === 'string' &&
    typeof value.expires === 'number' &&
    value.expires > Date.now()
    ? value.platform
    : undefined;
}

export async function finishLocalThoughtCallback({
  callback,
  pending,
  drive,
  actor,
  origin,
  finish,
  persist,
  cancel,
}: {
  callback: LocalThoughtCallbackData;
  pending: PendingLocalThoughtConnection | undefined;
  drive: string;
  actor: string | undefined;
  origin: string;
  finish: (input: {
    drive: string;
    state: string;
    connectionCode: string;
    origin: string;
  }) => Promise<{ connection: string; platform: string }>;
  persist: (connection: {
    connection: string;
    platform: string;
    drive: string;
    actor: string;
    origin: string;
  }) => void;
  cancel: (input: {
    drive: string;
    actor: string;
    state: string;
    origin: string;
  }) => Promise<void> | void;
}): Promise<string> {
  if (
    !pending ||
    pending.state !== callback.state ||
    pending.drive !== drive ||
    pending.actor !== actor ||
    pending.platform !== callback.platform ||
    (!callback.code && callback.error !== 'access_denied') ||
    (callback.code && callback.error)
  )
    throw new Error(
      'Connection return is missing, expired or belongs to another account. Start connecting again.',
    );

  const pendingOrigin = pending.origin ?? origin;

  if (callback.error) {
    await cancel({
      drive,
      actor: actor!,
      state: callback.state,
      origin: pendingOrigin,
    });
    throw new Error(
      'The connection was not authorized. Start connecting again when you are ready.',
    );
  }

  const result = await finish({
    drive,
    state: callback.state,
    connectionCode: callback.code!,
    origin: pendingOrigin,
  });
  if (result.platform !== pending.platform)
    throw new Error('Returned platform did not match the requested platform');
  persist({ ...result, drive, actor: actor!, origin: pendingOrigin });

  return result.platform;
}

export function useLocalThoughtCompletedPlatform(
  drive: string | undefined,
  origin: string,
  entry: string,
) {
  const [returned, setReturned] = useState<string>();
  const store = useStore();
  useEffect(() => {
    const restore = () => {
      try {
        setReturned(
          completedPlatformForEntry(
            JSON.parse(
              sessionStorage.getItem('localthought-completed') || 'null',
            ),
            { drive, actor: store.getAgent()?.subject, origin, entry },
          ),
        );
      } catch {
        setReturned(undefined);
      }
    };

    restore();
    window.addEventListener('localthought-connected', restore);

    return () => window.removeEventListener('localthought-connected', restore);
  }, [drive, origin, entry, store]);

  return returned;
}

/** Complete OAuth above discovery categories, which users may change during consent. */
export function LocalThoughtCallback({ drive }: { drive?: string }) {
  const store = useStore();
  const origin = useIntegrationProxy();
  const [error, setError] = useState('');
  const completing = useRef(false);
  useEffect(() => {
    if (!drive || completing.current) return;
    const url = new URL(location.href);
    const state = url.searchParams.get('integration_state');
    if (!state) return;
    completing.current = true;
    const callback = {
      state,
      code: url.searchParams.get('connection_code') ?? undefined,
      platform: url.searchParams.get('platform') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
    };
    history.replaceState(history.state, '', url.pathname);
    let pending: PendingLocalThoughtConnection | undefined;

    try {
      const raw = sessionStorage.getItem('localthought-pending');
      pending = raw ? JSON.parse(raw) : undefined;
    } catch {
      /* Validation reports malformed pending state. */
    }

    const actor = store.getAgent()?.subject;
    sessionStorage.removeItem('localthought-pending');
    void finishLocalThoughtCallback({
      callback,
      pending,
      drive,
      actor,
      origin,
      finish: input => proxyRequest(store, 'finish', input),
      cancel: input =>
        browserIntegrations(input.origin).cancel(
          input.drive,
          input.actor,
          input.state,
        ),
      persist: connection =>
        localStorage.setItem(
          connectionKey(
            connection.drive,
            connection.actor,
            connection.platform,
            connection.origin,
          ),
          JSON.stringify(connection),
        ),
    })
      .then(platform => {
        sessionStorage.setItem(
          'localthought-completed',
          JSON.stringify({
            drive,
            actor,
            platform,
            origin: pending?.origin ?? origin,
            entry: pending && callbackEntry(pending),
            expires: Date.now() + 600000,
          }),
        );
        window.dispatchEvent(new Event('localthought-connected'));
      })
      .catch(reason => setError(String(reason)));
  }, [drive, store, origin]);

  return error ? <ErrMessage role='alert'>{error}</ErrMessage> : null;
}
