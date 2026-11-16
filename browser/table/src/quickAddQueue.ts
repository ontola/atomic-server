export interface TableQuickAddState {
  pending: number;
  failures: readonly { value: string; error: unknown }[];
}
export interface TableQuickAddRequest {
  value: string;
  create: (value: string) => Promise<unknown>;
  onCreated?: () => void;
  onError?: (error: unknown) => void;
}
/** Each accepted request retains its backend binding; changing a view cannot
 * redirect already queued writes. Failures are reported, never auto-retried. */
export function createTableQuickAddQueue() {
  let state: TableQuickAddState = { pending: 0, failures: [] };
  let active = true;
  let running = false;
  const queue: TableQuickAddRequest[] = [];
  const listeners = new Set<() => void>();

  const emit = () => {
    if (active) for (const listener of listeners) listener();
  };

  const drain = async () => {
    running = true;

    while (queue.length) {
      const request = queue[0];

      try {
        await request.create(request.value);

        if (active) {
          try {
            request.onCreated?.();
          } catch {
            /* Observer failure is not a failed write. */
          }
        }
      } catch (error) {
        state = {
          ...state,
          failures: [...state.failures, { value: request.value, error }],
        };

        try {
          request.onError?.(error);
        } catch {
          /* Keep draining accepted requests. */
        }
      }

      queue.shift();
      state = { ...state, pending: queue.length };
      emit();
    }

    running = false;
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    activate: () => {
      active = true;
    },
    deactivate: () => {
      active = false;
    },
    enqueue: (request: TableQuickAddRequest) => {
      queue.push(request);
      state = { ...state, pending: queue.length };
      emit();
      if (!running) void drain();
    },
  };
}
