import {
  core,
  Resource,
  useCollection,
  UseCollectionResult,
  useResource,
  useStore,
  useSubject,
} from '@tomic/react';
import { useReducer } from 'react';
import { TableSorting, DEFAULT_SORT_PROP } from './tableSorting';

const PAGE_SIZE = 30;
const DEFAULT_SORT = {
  prop: DEFAULT_SORT_PROP,
  sortDesc: false,
};

type UseTableDataResult = {
  tableClass: Resource;
  sorting: TableSorting;
  setSortBy: React.Dispatch<string>;
} & UseCollectionResult;

const useTableSorting = () =>
  useReducer((state: TableSorting, property: string) => {
    if (state.prop === property && state.sortDesc) {
      return DEFAULT_SORT;
    }

    if (state.prop === property) {
      return {
        ...state,
        sortDesc: true,
      };
    }

    return {
      prop: property,
      sortDesc: false,
    };
  }, DEFAULT_SORT);

export function useTableData(resource: Resource): UseTableDataResult {
  const [sorting, setSortBy] = useTableSorting();
  const store = useStore();

  const [classSubject] = useSubject(resource, core.properties.classtype);
  const tableClass = useResource(classSubject);

  const queryFilter = {
    property: core.properties.parent,
    value: resource.subject,
    sort_by: sorting.prop,
    sort_desc: sorting.sortDesc,
  };

  const { collection, ready, invalidateCollection, mapAll } = useCollection(
    queryFilter,
    {
      pageSize: PAGE_SIZE,
      server: resource.subject.startsWith('http')
        ? new URL(resource.subject).origin
        : store.getServerUrl(),
    },
  );

  return {
    tableClass,
    sorting,
    setSortBy,
    collection,
    ready,
    invalidateCollection,
    mapAll,
  };
}
