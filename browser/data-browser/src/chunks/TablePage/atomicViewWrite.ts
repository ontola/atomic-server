import type { TableViewWriteContext } from '@tomic/table';

export interface AtomicViewWriteContext extends TableViewWriteContext {
  /** Call before the first mutation, so an uncertain/partial save cannot be abandoned. */
  beforeMutation: () => void;
}
