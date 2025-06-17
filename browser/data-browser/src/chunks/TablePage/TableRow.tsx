import {
  memo,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  Collection,
  DataBrowser,
  Property,
  Resource,
  core,
  unknownSubject,
  useMemberFromCollection,
  useResource,
} from '@tomic/react';
import { TableCell } from './TableCell';
import { randomSubject } from '../../helpers/randomString';
import { styled, keyframes } from 'styled-components';
import { useTableEditorContext } from '@chunks/TableEditor/TableEditorContext';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { useTableInvalidation } from './useTableInvalidation';

interface TableRowProps {
  collection: Collection;
  index: number;
  columns: Property[];
}

const WarningIcon = styled(FaTriangleExclamation)`
  color: ${p => p.theme.colors.warning};
`;

const TableCellMemo = memo(TableCell);

function useMarkings(row: Resource, index: number) {
  const { setMarkings } = useTableEditorContext();

  const addMarkings = useEffectEvent(() => {
    setMarkings(markings => {
      const newMap = new Map(markings);
      newMap.set(
        index,
        <WarningIcon title='Row is incomplete or has invalid data' />,
      );

      return newMap;
    });
  });

  const removeMarkings = useEffectEvent(() => {
    setMarkings(markings => {
      const newMap = new Map(markings);
      newMap.delete(index);

      return newMap;
    });
  });

  useEffect(() => {
    if (row.commitError) {
      addMarkings();
    }

    return () => {
      removeMarkings();
    };

    // Markings don't need to be updated when the function address changes...
  }, [row.commitError, index]);
}

export function TableRow({
  collection,
  index,
  columns,
}: TableRowProps): JSX.Element {
  const resource = useMemberFromCollection(collection, index);

  useMarkings(resource, index);

  if (resource.subject === unknownSubject) {
    return (
      <>
        {columns.map((column, i) => (
          <Loader key={column.subject} delay={i * 100} title='loading' />
        ))}
      </>
    );
  }

  return (
    <>
      {columns.map((column, cIndex) => (
        <TableCellMemo
          key={column.subject}
          rowIndex={index}
          columnIndex={cIndex + 1}
          subject={resource.subject}
          property={column}
        />
      ))}
    </>
  );
}

type TableNewRowProps = Omit<TableRowProps, 'collection'> & {
  parent: Resource<DataBrowser.Table>;
  invalidateTable: () => void;
};

const resourceOpts = {
  newResource: true,
};

export function TableNewRow({
  index,
  columns,
  parent,
  invalidateTable,
}: TableNewRowProps): JSX.Element {
  const [subject] = useState<string>(() =>
    randomSubject(parent.subject, 'row'),
  );

  const [loading, setLoading] = useState(true);

  const resource = useResource(subject, resourceOpts);
  const resourceRef = useRef(resource);
  const onEditNextRow = useTableInvalidation(resource, invalidateTable);

  useMarkings(resource, index);

  useEffect(() => {
    if (resource.subject === unknownSubject || resource.commitError) {
      return;
    }

    resourceRef.current
      .set(core.properties.parent, parent.subject)
      .then(() =>
        resourceRef.current.set(core.properties.isA, [parent.props.classtype]),
      )
      .then(() => {
        setLoading(false);
      });

    // We can't add resource to the list because we modify the resource in the effect so it would cause a loop.
    // We put resource in a ref so we don't need to add it to the list.
  }, [
    resource.subject,
    parent.subject,
    parent.props.classtype,
    resource.commitError,
  ]);

  if (loading) {
    return (
      <>
        {columns.map((column, i) => (
          <Loader key={column.subject} delay={i * 100} />
        ))}
      </>
    );
  }

  return (
    <>
      {columns.map((column, cIndex) => (
        <TableCellMemo
          key={column.subject}
          rowIndex={index}
          columnIndex={cIndex + 1}
          subject={resource.subject}
          property={column}
          onEditNextRow={onEditNextRow}
        />
      ))}
    </>
  );
}

const pulse = keyframes`
  from {
    background-color: var(--from-color);
  }

  to {
    background-color: var(--to-color);
  }
`;

interface LoaderProps {
  delay: number;
}

const Loader = styled.div<LoaderProps>`
  width: 100%;
  --from-color: ${p => p.theme.colors.bg};
  --to-color: ${p => p.theme.colors.bg1};
  animation: 0.8s ${p => p.delay}ms ease-in-out infinite alternate ${pulse};
`;
