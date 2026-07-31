import { useId, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  FaChartBar,
  FaFont,
  FaHashtag,
  FaPlus,
  FaTable,
} from 'react-icons/fa6';
import { ContainerFull } from '../../components/Containers';
import { EditableTitle } from '../../components/EditableTitle';
import { Column, Row } from '../../components/Row';
import { DropdownMenu, type DropdownItem } from '../../components/Dropdown';
import { buildDefaultTrigger } from '../../components/Dropdown/DefaultTrigger';
import type { ResourcePageProps } from '../../views/ResourcePage';
import {
  BLOCK_KINDS,
  BLOCK_KIND_DESCRIPTIONS,
  BLOCK_KIND_LABELS,
  GRID_COLUMNS,
  type BlockKind,
} from './dashboardBlocks';
import { useDashboard } from './useDashboard';
import { DashboardBlock } from './DashboardBlock';

const AddBlockTrigger = buildDefaultTrigger(<FaPlus />, 'Add block');

const KIND_ICONS: Record<BlockKind, JSX.Element> = {
  stat: <FaHashtag />,
  chart: <FaChartBar />,
  view: <FaTable />,
  text: <FaFont />,
};

/**
 * A composed page of blocks over a Drive's data.
 *
 * The blocks are resources, so this page renders stored configuration and
 * nothing else — which is what makes a dashboard an assistant writes and a
 * dashboard a person builds the same object.
 */
export function DashboardPage({ resource }: ResourcePageProps): JSX.Element {
  const titleId = useId();
  const {
    blocks,
    layout,
    canWrite,
    addBlock,
    removeBlock,
    moveBlock,
    setPlacement,
  } = useDashboard(resource);

  // Which block's config dialog is open. A block created from the Add menu opens
  // its own, so a new block is configured instead of sitting there empty.
  const [configuring, setConfiguring] = useState<string | undefined>(undefined);

  const addItems: DropdownItem[] = BLOCK_KINDS.map(kind => ({
    id: kind,
    label: BLOCK_KIND_LABELS[kind],
    helper: BLOCK_KIND_DESCRIPTIONS[kind],
    icon: KIND_ICONS[kind],
    onClick: () => {
      void addBlock(kind, BLOCK_KIND_LABELS[kind])
        .then(subject => setConfiguring(subject))
        .catch(() => undefined);
    },
  }));

  const placementBySubject = new Map(layout.map(p => [p.subject, p]));

  return (
    <ContainerFull>
      <Column>
        <Row justify='space-between' center>
          <EditableTitle resource={resource} id={titleId} withDecorations />
          {canWrite && (
            <DropdownMenu Trigger={AddBlockTrigger} items={addItems} />
          )}
        </Row>

        {blocks.length === 0 ? (
          <Empty>
            {canWrite
              ? 'Nothing here yet. Add a number, a chart or a table.'
              : 'This dashboard has no blocks yet.'}
          </Empty>
        ) : (
          <Grid data-testid='dashboard-grid'>
            {blocks.map((subject, index) => (
              <DashboardBlock
                key={subject}
                subject={subject}
                placement={placementBySubject.get(subject)}
                canWrite={canWrite}
                isFirst={index === 0}
                isLast={index === blocks.length - 1}
                configuring={configuring === subject}
                onConfigureOpen={() => setConfiguring(subject)}
                onConfigureClose={() => setConfiguring(undefined)}
                onRemove={() =>
                  void removeBlock(subject).catch(() => undefined)
                }
                onMove={direction =>
                  void moveBlock(subject, direction).catch(() => undefined)
                }
                onResize={size =>
                  void setPlacement(subject, size).catch(() => undefined)
                }
              />
            ))}
          </Grid>
        )}
      </Column>
    </ContainerFull>
  );
}

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(${GRID_COLUMNS}, 1fr);
  grid-auto-rows: minmax(7rem, auto);
  gap: ${p => p.theme.size(2)};
  align-items: stretch;

  /* One column when there isn't room: a 3-of-12 stat block is unreadable at
   * phone width, and a dashboard is exactly the kind of page people open on a
   * phone. */
  @media (max-width: 50rem) {
    grid-template-columns: 1fr;
  }
`;

const Empty = styled.p`
  color: ${p => p.theme.colors.textLight};
`;
