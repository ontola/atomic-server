import { env } from '@/env';
import { Store } from '@tomic/lib';

export const store = new Store({
  serverUrl: env.NEXT_PUBLIC_ATOMIC_SERVER_URL,
});

store.setDrive(env.NEXT_PUBLIC_ATOMIC_DRIVE);

// Server Components have no browser connection lifecycle. Mark the HTTP
// origin available so collection queries use the server instead of the empty
// local fallback; client-side stores still derive this state from WebSocket.
if (typeof window === 'undefined') {
  store.setServerConnected(true);
}
