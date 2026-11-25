import {
  JSONValue,
  Resource,
  Store,
  useStore,
  type AtomicValue,
} from '@tomic/react';
import { useCallback, useRef } from 'react';
import { saveTableChange } from '../tableSave.js';

enum HistoryItemType {
  ValueChange,
  ResourceCreated,
  ResourceDeleted,
}

interface ValueChangeItem {
  type: HistoryItemType.ValueChange;
  subject: string;
  property: string;
  previousValue: JSONValue;
}

interface ResourceCreatedItem {
  type: HistoryItemType.ResourceCreated;
  subject: string;
}

interface ResourceDeletedItem {
  type: HistoryItemType.ResourceDeleted;
  subject: string;
  propVals: [string, AtomicValue][];
}

type HistoryItem = ValueChangeItem | ResourceCreatedItem | ResourceDeletedItem;

export type HistoryItemBatch = HistoryItem[];

export type HistoryStack = Array<HistoryItem | HistoryItemBatch>;

export type AddItemToHistoryStack = (
  item: HistoryItem | HistoryItemBatch,
) => void;

const isValueChangeItem = (
  item: HistoryItem | HistoryItemBatch,
): item is ValueChangeItem =>
  !Array.isArray(item) && item.type === HistoryItemType.ValueChange;

const isResourceCreatedItem = (
  item: HistoryItem | HistoryItemBatch,
): item is ResourceCreatedItem =>
  !Array.isArray(item) && item.type === HistoryItemType.ResourceCreated;

export function createValueChangedHistoryItem(
  resource: Resource,
  property: string,
): ValueChangeItem {
  return {
    type: HistoryItemType.ValueChange,
    subject: resource.subject,
    property,
    previousValue: resource.get(property),
  };
}

export function createResourceCreatedHistoryItem(
  resource: Resource,
): ResourceCreatedItem {
  return {
    type: HistoryItemType.ResourceCreated,
    subject: resource.subject,
  };
}

export function createResourceDeletedHistoryItem(
  resource: Resource,
): ResourceDeletedItem {
  return {
    type: HistoryItemType.ResourceDeleted,
    subject: resource.subject,
    propVals: resource.getEntries(),
  };
}

async function undoValueChange(item: ValueChangeItem, store: Store) {
  const resource = store.getResourceLoading(item.subject);

  await resource.set(item.property, item.previousValue, false);
  await saveTableChange(resource);
}

async function undoResourceCreated(item: ResourceCreatedItem, store: Store) {
  const resource = store.getResourceLoading(item.subject);

  await resource.destroy();

  return true;
}

async function undoResourceDeleted(item: ResourceDeletedItem, store: Store) {
  const resource = store.getResourceLoading(item.subject, {
    newResource: true,
  });

  for (const [prop, val] of item.propVals) {
    await resource.set(prop, val, false);
  }

  await saveTableChange(resource);

  return true;
}

async function undoItem(item: HistoryItem, store: Store) {
  switch (item.type) {
    case HistoryItemType.ValueChange:
      return undoValueChange(item, store);
    case HistoryItemType.ResourceCreated:
      return undoResourceCreated(item, store);
    case HistoryItemType.ResourceDeleted:
      return undoResourceDeleted(item, store);
  }
}

const shouldMergeItem = (
  item: ValueChangeItem,
  lastItem: HistoryItem | HistoryItemBatch,
) => {
  const matchingValueChangeItem =
    isValueChangeItem(lastItem) &&
    lastItem.subject === item.subject &&
    lastItem.property === item.property;

  const matchingResourceCreatedItem =
    isResourceCreatedItem(lastItem) && lastItem.subject === item.subject;

  return matchingValueChangeItem || matchingResourceCreatedItem;
};

function addSingleItem(item: HistoryItem, stack: HistoryStack) {
  const lastItem = stack[stack.length - 1];

  if (lastItem && isValueChangeItem(item) && shouldMergeItem(item, lastItem)) {
    // If the last item is the same except for value we don't record the new value. This is to prevent recording values every keystroke.
    return stack;
  }

  return [...stack, item];
}

export function useTableHistory(invalidateTable: () => void) {
  const store = useStore();
  const stack = useRef<HistoryStack>([]);
  const undoing = useRef<HistoryStack[number] | undefined>(undefined);

  const addItemsToHistoryStack: AddItemToHistoryStack = useCallback(item => {
    const current = stack.current;
    stack.current =
      Array.isArray(item) || current.at(-1) === undoing.current
        ? [...current, item]
        : addSingleItem(item, current);
  }, []);

  const undoLastItem = useCallback(async () => {
    const index = stack.current.length - 1;
    const lastItem = stack.current[index];
    if (!lastItem || undoing.current) return;

    const items = Array.isArray(lastItem) ? lastItem : [lastItem];
    undoing.current = lastItem;
    let completed = 0;
    let shouldInvalidate = false;

    try {
      for (const item of items) {
        const collectionUpdated = await undoItem(item, store);
        completed++;
        if (collectionUpdated) shouldInvalidate = true;
      }
    } finally {
      const remaining = items.slice(completed);
      // An edit added during undo stays above the entry this command started on.
      stack.current.splice(index, 1, ...(remaining.length ? [remaining] : []));
      undoing.current = undefined;

      if (shouldInvalidate) invalidateTable();
    }
  }, [store, invalidateTable]);

  return { addItemsToHistoryStack, undoLastItem };
}
