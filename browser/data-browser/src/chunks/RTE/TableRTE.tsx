import { AtomicLink } from '@tomic/resource-ui/components/AtomicLink';
import { HideInPrint } from '@tomic/ui/components/HideInPrint';
import { useResource, type DataBrowser } from '@tomic/react';
import { lazy, Suspense } from 'react';
import { FaArrowUpRightFromSquare } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { Spinner } from '@components/Spinner';

const TableResource = lazy(() =>
  import('@tomic/table-page/TablePage/TableResource').then(m => ({
    default: m.TableResource,
  })),
);

interface TableRTEProps {
  subject: string;
}

export const TableRTE: React.FC<TableRTEProps> = ({ subject }) => {
  const resource = useResource<DataBrowser.Table>(subject);

  return (
    <HideInPrint>
      <div>
        <Suspense fallback={<Spinner centered />}>
          <TableResource resource={resource} />
        </Suspense>
        <TableTitle subject={resource.subject}>
          {resource.title} <FaArrowUpRightFromSquare size={'0.9rem'} />
        </TableTitle>
      </div>
    </HideInPrint>
  );
};

const TableTitle = styled(AtomicLink)`
  display: flex;
  align-items: center;
  gap: 1ch;
  color: ${p => p.theme.colors.textLight};
  padding-inline-start: 0.5rem;
`;
