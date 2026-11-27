import { SaveQueuedError, type Resource } from '@tomic/react';

export async function saveTableChange(resource: Resource): Promise<void> {
  const result = await resource.save();

  // An offline save is already recorded durably by the SDK. A child waiting
  // in memory for its unsaved parent cannot be reported as saved yet.
  if (result === 'queued') throw new SaveQueuedError();
  if (result === 'noop' && resource.commitError) throw resource.commitError;
}
