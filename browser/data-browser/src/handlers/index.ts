import { Store, StoreEvents } from '@tomic/react';
import { errorHandler } from './errorHandler';

export function registerHandlers(store: Store) {
  store.on(StoreEvents.Error, errorHandler);
}
