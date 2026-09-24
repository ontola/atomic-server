/** Versioned UI wire contract. Authority comes from the host's view instance. */
export const VIEW_PROTOCOL_VERSION = 1;
export type ViewOperation =
  | 'app'
  | 'data'
  | 'get'
  /** Up to 100 `get`s in one round trip; per-subject errors in place. */
  | 'getMany'
  | 'query'
  | 'create'
  | 'save'
  | 'destroy'
  | 'patch'
  | 'context'
  | 'navigate'
  | 'pickResource'
  | 'pickFile'
  | 'search'
  | 'subscribe'
  | 'unsubscribe'
  /**
   * A capability for one integration-proxy connection, bound to the frame's
   * own public key and signed by the user (ontola/atomic-plugins#54).
   */
  | 'proxyCapability'
  /** Connection references (never credentials) delegated to this app. */
  | 'proxyConnections'
  /** Ask the person, in host UI, to connect a proxy platform for this app. */
  | 'proxyConnect'
  /**
   * Take this app's delegation off its connections for a platform. Never
   * deletes a connection; other apps may share it.
   */
  | 'proxyDisconnect'
  /**
   * Open an http(s) link in a new tab, once the person confirms it in host
   * UI that names the destination host. The frame gets no popup rights.
   */
  | 'openExternal'
  /** Show a resource the person can already read in the host page. */
  | 'openResource';
export interface ViewRequest {
  type: 'atomic.view.request';
  version: 1;
  id: string | number;
  op: ViewOperation;
  args: Record<string, unknown>;
}
export interface ViewResponse {
  type: 'atomic.view.response';
  version: 1;
  id: string | number;
  result?: unknown;
  error?: string;
}
export function viewRequest(
  id: string | number,
  op: ViewOperation,
  args: Record<string, unknown> = {},
): ViewRequest {
  return {
    type: 'atomic.view.request',
    version: VIEW_PROTOCOL_VERSION,
    id,
    op,
    args,
  };
}
export function isViewRequest(value: unknown): value is ViewRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as ViewRequest;

  return (
    request.type === 'atomic.view.request' &&
    request.version === 1 &&
    ((typeof request.id === 'string' && request.id.length > 0) ||
      (typeof request.id === 'number' && Number.isSafeInteger(request.id))) &&
    [
      'app',
      'data',
      'get',
      'getMany',
      'query',
      'create',
      'save',
      'destroy',
      'patch',
      'context',
      'navigate',
      'pickResource',
      'pickFile',
      'search',
      'subscribe',
      'unsubscribe',
      'proxyCapability',
      'proxyConnections',
      'proxyConnect',
      'proxyDisconnect',
      'openExternal',
      'openResource',
    ].includes(request.op) &&
    !!request.args &&
    typeof request.args === 'object' &&
    !Array.isArray(request.args)
  );
}

/** Existing package APIs keep their method names; only their wire codec changes. */
export const packagedViewOperations = {
  'get-resource': 'get',
  query: 'query',
  commit: 'patch',
  search: 'search',
  'get-context': 'context',
  navigate: 'navigate',
  'pick-resource': 'pickResource',
  'pick-file': 'pickFile',
  subscribe: 'subscribe',
  unsubscribe: 'unsubscribe',
} as const satisfies Record<string, ViewOperation>;
