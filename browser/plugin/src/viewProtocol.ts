/** Versioned UI wire contract. Authority comes from the host's view instance. */
export const VIEW_PROTOCOL_VERSION = 1;
export type ViewOperation =
  | 'app'
  | 'data'
  | 'get'
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
   * Run this app's own importer on a file, reviewed and applied by the person
   * in host UI (atomic-server#1739). Args: {@link ImporterRunArgs}; result:
   * {@link ImporterRunResult}.
   */
  | 'runImporter';
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
      'runImporter',
    ].includes(request.op) &&
    !!request.args &&
    typeof request.args === 'object' &&
    !Array.isArray(request.args)
  );
}

/** A file the app already has, handed to its importer as `input.upload`. */
export interface ImporterFile {
  name: string;
  mediaType?: string;
  /** The file's text. The host checks it against the importer's `accepts`. */
  text: string;
}

/** `store.importer.run(args)`. */
export interface ImporterRunArgs {
  /** Omit to have the host ask the person to choose a file. */
  file?: ImporterFile;
  /**
   * The importer the app expects, as a check. The host resolves the importer
   * itself, from the table the app is a view of, and refuses any other.
   */
  importer?: string;
}

/**
 * What `store.importer.run()` resolves to. Nothing is written unless the
 * person applies the reviewed changes, so `cancelled`, `nothing` and `blocked`
 * all mean the drive is unchanged.
 */
export type ImporterRunResult =
  | {
      status: 'applied';
      importer: string;
      /** Changes applied, by kind. */
      created: number;
      updated: number;
      destroyed: number;
      /** Changes that failed; the drive keeps what did apply. */
      failed: number;
      /** One message per failed change. */
      errors: string[];
    }
  | {
      /** The person closed the picker or the review without applying. */
      status: 'cancelled';
      importer: string;
    }
  | {
      /** The importer proposed no changes: everything was imported before. */
      status: 'nothing';
      importer: string;
    }
  | {
      /** The importer refused the file; `errors` says why. */
      status: 'blocked';
      importer: string;
      errors: string[];
    };

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
