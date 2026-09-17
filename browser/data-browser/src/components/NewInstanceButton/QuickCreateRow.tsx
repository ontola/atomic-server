import {
  FaComment,
  FaFileLines,
  FaFolder,
  FaPlus,
  FaTable,
  FaVideo,
} from 'react-icons/fa6';
import type { CSSProperties, JSX } from 'react';
import { styled } from 'styled-components';
import { Row } from '../Row';
import { IconButton } from '../IconButton/IconButton';
import { useNewResourceUI } from '../forms/NewForm/useNewResourceUI';
import { dataBrowser } from '@tomic/react';
import { useNewRoute } from '../../helpers/useNewRoute';

interface QuickCreateRowProps {
  parent: string;
  className?: string;
  /** E2E: only set on the sidebar row so "New" is unique (drive/folder rows omit this). */
  newResourceButtonTestId?: string;
  /** e.g. close sidebar on narrow viewports (same callback as sidebar resource links). */
  onItemClick?: () => unknown;
}

/** Leading column width matches sidebar tree class / caret slot (see SidebarItemTitle). */
const SIDEBAR_LEADING_SLOT = '1.5rem';

/** A row of buttons for quickly creating new resources */
export function QuickCreateRow({
  parent,
  className,
  newResourceButtonTestId,
  onItemClick,
}: QuickCreateRowProps): JSX.Element {
  const createNewResource = useNewResourceUI();
  // The "New" button needs to land on /app/new with `parent` preserved as
  // `parentSubject` — otherwise NewRoute falls back to drive and any upload
  // there gets reparented to the drive instead of this row's container.
  const navigateToNewRoute = useNewRoute(parent);

  return (
    <QuickRow gap='0.15rem' center align='center' className={className}>
      <NewResourceOpacity>
        <NewResourceTrigger
          type='button'
          title='New resource'
          data-testid={newResourceButtonTestId}
          onClick={() => {
            onItemClick?.();
            navigateToNewRoute();
          }}
        >
          <PlusSlot>
            <FaPlus />
          </PlusSlot>
          <NewLabelText>New</NewLabelText>
        </NewResourceTrigger>
      </NewResourceOpacity>
      <IconButtonWrapper style={{ '--i': 0 } as CSSProperties}>
        <IconButton
          color='textLight'
          title='New Meeting'
          onClick={() => {
            onItemClick?.();
            createNewResource(dataBrowser.classes.meeting, parent);
          }}
        >
          <FaVideo />
        </IconButton>
      </IconButtonWrapper>
      <IconButtonWrapper style={{ '--i': 1 } as CSSProperties}>
        <IconButton
          color='textLight'
          title='New Document'
          onClick={() => {
            onItemClick?.();
            createNewResource(dataBrowser.classes.documentV2, parent);
          }}
        >
          <FaFileLines />
        </IconButton>
      </IconButtonWrapper>
      <IconButtonWrapper style={{ '--i': 2 } as CSSProperties}>
        <IconButton
          color='textLight'
          title='New Table'
          onClick={() => {
            onItemClick?.();
            createNewResource(dataBrowser.classes.table, parent);
          }}
        >
          <FaTable />
        </IconButton>
      </IconButtonWrapper>
      <IconButtonWrapper style={{ '--i': 3 } as CSSProperties}>
        <IconButton
          color='textLight'
          title='New Folder'
          onClick={() => {
            onItemClick?.();
            createNewResource(dataBrowser.classes.folder, parent);
          }}
        >
          <FaFolder />
        </IconButton>
      </IconButtonWrapper>
      <IconButtonWrapper style={{ '--i': 4 } as CSSProperties}>
        <IconButton
          color='textLight'
          title='New ChatRoom'
          onClick={() => {
            onItemClick?.();
            createNewResource(dataBrowser.classes.chatroom, parent);
          }}
        >
          <FaComment />
        </IconButton>
      </IconButtonWrapper>
    </QuickRow>
  );
}

const NewResourceOpacity = styled.span`
  display: inline-flex;
  opacity: 0.55;
  transition: opacity 0.2s;

  &:hover {
    opacity: 1;
  }
`;

const NewResourceTrigger = styled.button`
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: none;
  background: transparent;
  margin: 0;
  padding: 0.2rem;
  border-radius: ${p => p.theme.radius};
  cursor: pointer;
  color: ${p => p.theme.colors.textLight};
  font: inherit;

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
  }

  &:active {
    background-color: ${p => p.theme.colors.bg2};
  }

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: 1px;
  }
`;

const PlusSlot = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: ${SIDEBAR_LEADING_SLOT};

  svg {
    font-size: 0.85rem;
  }
`;

const NewLabelText = styled.span`
  font-size: 0.9rem;
`;

/**
 * Only "New" shows at rest. The class shortcuts slide in left to right when
 * the row is hovered or focused — a hint of what's there without a
 * permanent strip of grey icons under every tree. Touch has no hover, so
 * there they stay hidden and the "New" page carries the same choices.
 */
const QuickRow = styled(Row)``;

const IconButtonWrapper = styled.span`
  @media (hover: none) {
    display: none;
  }

  opacity: 0;
  transform: translateX(-0.4rem);
  transition:
    opacity 0.15s ease-out,
    transform 0.15s ease-out;
  /* Stagger: each icon follows the previous one. */
  transition-delay: calc(var(--i, 0) * 40ms);

  ${QuickRow}:hover &,
  ${QuickRow}:focus-within & {
    opacity: 0.5;
    transform: none;
  }

  ${QuickRow}:hover &:hover,
  &:focus-within {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    transform: none;
    transition-delay: 0s;
  }
`;
