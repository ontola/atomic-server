import { dataBrowser, useResource, useString } from '@tomic/react';
import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  FaArrowLeft,
  FaArrowRight,
  FaEllipsis,
  FaGear,
  FaLeftRight,
  FaTrash,
} from 'react-icons/fa6';
import {
  DIVIDER,
  DropdownMenu,
  type DropdownItem,
} from '../../components/Dropdown';
import { buildDefaultTrigger } from '../../components/Dropdown/DefaultTrigger';
import {
  GRID_COLUMNS,
  defaultSizeFor,
  isBlockKind,
  type BlockPlacement,
} from './dashboardBlocks';
import { BlockRenderer } from './BlockRenderer';
import { BlockConfigDialog } from './BlockConfigDialog';

interface Props {
  subject: string;
  /** The stored placement, if this block has one. */
  placement: BlockPlacement | undefined;
  canWrite: boolean;
  isFirst: boolean;
  isLast: boolean;
  configuring: boolean;
  onConfigureOpen: () => void;
  onConfigureClose: () => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onResize: (size: { x: number; y: number; w: number; h: number }) => void;
}

const BlockOptionsTrigger = buildDefaultTrigger(
  <FaEllipsis />,
  'Block options',
);

/** The widths offered in the menu, as a fraction of the 12-column grid. */
const WIDTHS: { label: string; w: number }[] = [
  { label: 'Quarter', w: 3 },
  { label: 'Third', w: 4 },
  { label: 'Half', w: 6 },
  { label: 'Two thirds', w: 8 },
  { label: 'Full width', w: 12 },
];

/**
 * One block on the grid: its size, the controls a writer gets, and its renderer.
 *
 * The kind is read here because the *default* size depends on it — a number is a
 * quarter of a row, a table is the full width — so a block nobody has sized still
 * looks deliberate. Reordering is offered before free drag-and-drop because it is
 * what a keyboard and a screen reader can also do.
 */
export function DashboardBlock({
  subject,
  placement,
  canWrite,
  isFirst,
  isLast,
  configuring,
  onConfigureOpen,
  onConfigureClose,
  onRemove,
  onMove,
  onResize,
}: Props): JSX.Element {
  const block = useResource(subject);
  const [kind] = useString(block, dataBrowser.properties.blockKind);
  const [showConfig, setShowConfig] = useState(false);

  const fallback = defaultSizeFor(isBlockKind(kind) ? kind : 'text');
  const width = placement?.w ?? fallback.w;
  const height = placement?.h ?? fallback.h;

  // Flat, because the menu is flat: a "Width" header followed by the widths,
  // each keeping the menu open so several tries cost one click each.
  const resizeItems = WIDTHS.map(({ label, w }) => ({
    id: `width-${w}`,
    label: w === width ? `${label} ✓` : label,
    keepOpen: true,
    onClick: () =>
      onResize({
        x: placement?.x ?? 0,
        y: placement?.y ?? 0,
        w,
        h: height,
      }),
  }));

  const menuItems: DropdownItem[] = [
    {
      id: 'configure',
      label: 'Configure',
      icon: <FaGear />,
      onClick: onConfigureOpen,
    },
    DIVIDER,
    {
      id: 'width-header',
      label: 'Width',
      icon: <FaLeftRight />,
      header: true,
      onClick: () => undefined,
    },
    ...resizeItems,
    DIVIDER,
    {
      id: 'move-earlier',
      label: 'Move earlier',
      icon: <FaArrowLeft />,
      disabled: isFirst,
      onClick: () => onMove(-1),
    },
    {
      id: 'move-later',
      label: 'Move later',
      icon: <FaArrowRight />,
      disabled: isLast,
      onClick: () => onMove(1),
    },
    DIVIDER,
    {
      id: 'remove',
      label: 'Remove',
      icon: <FaTrash />,
      onClick: onRemove,
    },
  ];

  return (
    <Cell $w={width} $h={height} data-testid='dashboard-block'>
      {canWrite && (
        <Controls>
          <DropdownMenu Trigger={BlockOptionsTrigger} items={menuItems} />
        </Controls>
      )}
      <BlockRenderer subject={subject} />
      {(configuring || showConfig) && (
        <BlockConfigDialog
          blockSubject={subject}
          show
          bindShow={open => {
            if (!open) {
              setShowConfig(false);
              onConfigureClose();
            }
          }}
        />
      )}
    </Cell>
  );
}

const Cell = styled.div<{ $w: number; $h: number }>`
  position: relative;
  display: flex;
  min-width: 0;
  grid-column: span ${p => Math.min(p.$w, GRID_COLUMNS)};
  grid-row: span ${p => p.$h};

  > * {
    flex: 1;
    min-width: 0;
  }

  /* Stacked into one column, spans mean nothing — and a three-row span would
   * leave two empty rows under a number. */
  @media (max-width: 50rem) {
    grid-column: span 1;
    grid-row: span 1;
  }
`;

/**
 * Floating over the block rather than in its header: the header is the block's
 * title, and a table block's header row is already busy.
 */
const Controls = styled.div`
  position: absolute;
  top: ${p => p.theme.size(1)};
  right: ${p => p.theme.size(1)};
  z-index: 1;
  opacity: 0;
  transition: opacity 0.1s ease-in-out;

  ${Cell}:hover &, &:focus-within {
    opacity: 1;
  }
`;
