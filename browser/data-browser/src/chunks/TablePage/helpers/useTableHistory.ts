import {
  JSONValue,
  Resource,
  Store,
  useStore,
  type AtomicValue,
} from '@tomic/react';
import { useCallback, useState } from 'react';
import { createTableHistory } from '@tomic/table';

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
    previousValue: structuredClone(resource.get(property)),
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
    propVals: structuredClone(resource.getEntries()),
  };
}

async function undoValueChange(item: ValueChangeItem, store: Store) {
  const resource = store.getResourceLoading(item.subject);

  await resource.set(item.property, item.previousValue, false);
  await resource.save();
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

  await resource.save();

  return true;
}

export async function undoAtomicTableHistoryItem(
  item: HistoryItem,
  store: Store,
) {
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

export function createAtomicTableHistory() {
  return createTableHistory<HistoryItem>({
    capture: item => structuredClone(item),
    merge: (previous, next) =>
      isValueChangeItem(next) && shouldMergeItem(next, previous)
        ? previous
        : undefined,
  });
}

export function useTableHistory(invalidateTable: () => void) {
  const store = useStore();
  const [history] = useState(createAtomicTableHistory);

  const addItemsToHistoryStack: AddItemToHistoryStack = useCallback(
    item => {
      if (Array.isArray(item)) history.recordBatch(item);
      else history.record(item);
    },
    [history],
  );

  const undoLastItem = useCallback(
    () =>
      history.undo(async item => {
        const collectionUpdated = await undoAtomicTableHistoryItem(item, store);
        // Invalidate even if a later item in this batch fails.
        if (collectionUpdated) invalidateTable();
      }),
    [history, store, invalidateTable],
  );

  return { addItemsToHistoryStack, undoLastItem };
}
