export type JSONPrimitive = string | number | boolean;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray | undefined;
export type JSONObject = { [key: string]: JSONValue };
export type JSONArray = Array<JSONValue>;

export interface Resource {
  subject: string;
  title: string;
  loading: boolean;
  props: Record<string, JSONValue>;
}

export interface Commit {
  subject: string;
  set?: Record<string, JSONValue>;
  push?: Record<string, unknown[]>;
  yUpdate?: Record<string, Uint8Array>;
  remove?: string[];
  destroy?: boolean;
}

export enum MessageType {
  GET_RESOURCE = 'get-resource',
  QUERY = 'query',
  COMMIT = 'commit',
  SEARCH = 'search',
  GET_CONTEXT = 'get-context',
  NAVIGATE = 'navigate',
  PICK_RESOURCE = 'pick-resource',
  PICK_FILE = 'pick-file',
  SUBSCRIBE = 'subscribe',
  UNSUBSCRIBE = 'unsubscribe',
}

export type PickResourceArgs = {
  isA?: string;
  scope?: string;
  message?: string;
  title?: string;
};

export type PickFileArgs = {
  allowedMimes?: string[];
};

export type ServerResponse = {
  type: 'response';
  requestId: string;
  data: unknown;
};

export type ResourceNotification = {
  type: 'resource-notification';
  resource: Resource;
};

export type ErrorResponse = {
  type: 'error';
  requestId: string;
  error: string;
  message?: string;
};

export type ServerMessage =
  | ServerResponse
  | ResourceNotification
  | ErrorResponse;

export type MessageArgs = {
  [MessageType.GET_RESOURCE]: {
    subject: string;
  };
  [MessageType.QUERY]: {
    property: string;
    value: string;
  };
  [MessageType.COMMIT]: {
    commit: unknown;
  };

  [MessageType.SEARCH]: {
    query: string;
  };
  [MessageType.GET_CONTEXT]: undefined;
  [MessageType.NAVIGATE]: {
    subject: string;
  };
  [MessageType.PICK_RESOURCE]: PickResourceArgs;
  [MessageType.PICK_FILE]: PickFileArgs;
  [MessageType.SUBSCRIBE]: {
    subject: string;
  };
  [MessageType.UNSUBSCRIBE]: {
    subject: string;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RPCMessage<T extends MessageType = any, A = MessageArgs[T]> {
  type: MessageType;
  args: A;
  requestId: string;
}

export interface PageContext {
  /** The current page resource */
  resource: Resource;
  /** Subject of the user's agent */
  agent?: string;
}
