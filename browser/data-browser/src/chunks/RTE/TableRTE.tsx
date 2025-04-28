import { AtomicLink } from '@components/AtomicLink';
import { HideInPrint } from '@components/HideInPrint';
import { useResource, type DataBrowser } from '@tomic/react';
import { TableResource } from '@views/TablePage/TableResource';
import { FaArrowUpRightFromSquare } from 'react-icons/fa6';
import { styled } from 'styled-components';

interface TableRTEProps {
  subject: string;
}

export const TableRTE: React.FC<TableRTEProps> = ({ subject }) => {
  const resource = useResource<DataBrowser.Table>(subject);

  return (
    <HideInPrint>
      <div>
        <TableResource resource={resource} />
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
