import { resourceTheme } from '../../theme.js';
import { Collection, useCollectionPage } from '@tomic/react';

import { styled } from 'styled-components';
import { Details } from '@tomic/ui/components/Details';
import { Column } from '@tomic/ui/components/Row';
import { useState, type JSX } from 'react';
import { FaChevronLeft, FaChevronRight } from 'react-icons/fa6';
import { IconButton } from '@tomic/ui/components/IconButton/IconButton';
import { CardInsideFull, CardRow } from '@tomic/ui/components/Card';
import { ResourceRow } from '../../views/ResourceRow.js';
interface UsageCardProps {
  collection: Collection;
  title: string | React.ReactNode;
  initialOpenState?: boolean;
}

export function UsageCard({
  collection,
  title,
  initialOpenState = false,
}: UsageCardProps): JSX.Element {
  const [page, setPage] = useState(0);
  const [isOpen, setIsOpen] = useState(initialOpenState);
  const members = useCollectionPage(collection, page);

  return (
    <DetailsCard>
      <Details
        noIndent
        disabled={collection.totalMembers === 0}
        summaryClickable={false}
        title={
          <DetailsTitleRow>
            <span>{title}</span>
            {isOpen && collection.totalPages > 1 && (
              <PageButtons>
                <IconButton
                  title='Previous page'
                  onClick={() => setPage(p => p - 1)}
                  disabled={page === 0}
                >
                  <FaChevronLeft />
                </IconButton>
                <PageNumber>{page + 1}</PageNumber>
                <IconButton
                  title='Next page'
                  onClick={() => setPage(p => p + 1)}
                  disabled={page === collection.totalPages - 1}
                >
                  <FaChevronRight />
                </IconButton>
              </PageButtons>
            )}
          </DetailsTitleRow>
        }
        initialState={initialOpenState}
        onStateToggle={setIsOpen}
      >
        <Column gap='0.5rem'>
          {members.length === 0 ? (
            <Empty>No resources</Empty>
          ) : (
            <CardInsideFull>
              {members.map(member => (
                <CardRow key={member}>
                  <ResourceRow clickable subject={member} />
                </CardRow>
              ))}
            </CardInsideFull>
          )}
        </Column>
      </Details>
    </DetailsCard>
  );
}

const DetailsCard = styled.div`
  border: 1px solid ${({ theme }) => resourceTheme(theme).colors.bg2};
  border-radius: ${({ theme }) => resourceTheme(theme).radius};
  background-color: ${({ theme }) => resourceTheme(theme).colors.bg};
`;

const DetailsTitleRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
`;

const PageButtons = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => resourceTheme(theme).size(1)};
`;

const PageNumber = styled.span`
  color: ${({ theme }) => resourceTheme(theme).colors.textLight};
  font-size: 0.875rem;
`;

const Empty = styled.span`
  color: ${({ theme }) => resourceTheme(theme).colors.textLight};
`;
