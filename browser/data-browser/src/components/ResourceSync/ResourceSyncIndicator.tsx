import { useId, useState, type JSX } from 'react';
import { useSaveState, useTitle, type Resource } from '@tomic/react';
import * as RadixPopover from '@radix-ui/react-popover';
import {
  FaCheck,
  FaCircleExclamation,
  FaClock,
  FaDesktop,
  FaServer,
  FaArrowUp,
} from 'react-icons/fa6';
import { styled } from 'styled-components';
import { IconButton } from '../IconButton/IconButton';
import { Popover } from '../Popover';
import { useResourceSyncStatus } from './useResourceSyncStatus';
import {
  resourceSyncPresentation,
  type SyncSymbol,
  type SyncTone,
} from './resourceSyncPresentation';
import { ResourceSyncPanel } from './ResourceSyncPanel';

/** A resource's own confirmed copies, separate from drive connection status. */
export function ResourceSyncIndicator({
  resource,
}: {
  resource: Resource;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [title] = useTitle(resource);
  const status = useResourceSyncStatus(resource);
  const save = useSaveState(resource);
  const presentation = resourceSyncPresentation(status, save);
  const headingId = useId();

  return (
    <Root onClick={event => event.stopPropagation()} data-resource-sync>
      <SyncPopover
        aria-labelledby={headingId}
        open={open}
        onOpenChange={setOpen}
        noLock
        Trigger={
          <RadixPopover.Trigger asChild>
            <SyncButton
              type='button'
              title={presentation.label}
              aria-label={`Copies and sync for ${title}: ${presentation.label}`}
              data-testid='resource-sync-indicator'
              data-sync-state={status.server.state}
              $tone={presentation.tone}
            >
              <StatusSymbol symbol={presentation.symbol} />
              {presentation.tone === 'confirmed' && (
                <CheckMark aria-hidden>
                  <FaCheck />
                </CheckMark>
              )}
            </SyncButton>
          </RadixPopover.Trigger>
        }
      >
        {open && (
          <ResourceSyncPanel
            resource={resource}
            status={status}
            save={save}
            headingId={headingId}
            onClose={() => setOpen(false)}
          />
        )}
      </SyncPopover>
    </Root>
  );
}

function StatusSymbol({ symbol }: { symbol: SyncSymbol }) {
  switch (symbol) {
    case 'server':
      return <FaServer aria-hidden />;
    case 'waiting':
      return <FaClock aria-hidden />;
    case 'saving':
      return <FaArrowUp aria-hidden />;
    case 'error':
      return <FaCircleExclamation aria-hidden />;
    default:
      return <FaDesktop aria-hidden />;
  }
}

const Root = styled.span`
  display: inline-flex;
  flex-shrink: 0;
`;

const SyncButton = styled(IconButton)<{ $tone: SyncTone }>`
  position: relative;
  color: ${p =>
    p.$tone === 'confirmed'
      ? p.theme.colors.success
      : p.$tone === 'pending' || p.$tone === 'attention'
        ? p.theme.colors.warning
        : p.theme.colors.textLight};

  @media (pointer: coarse) {
    min-width: 44px;
    min-height: 44px;
  }
`;

const CheckMark = styled.span`
  position: absolute;
  right: 1px;
  bottom: 2px;
  display: flex;
  padding: 1px;
  font-size: 0.55rem;
  border-radius: 50%;
  background: ${p => p.theme.colors.bg};
`;

const SyncPopover = styled(Popover)`
  width: min(350px, calc(100vw - 24px));
  max-height: var(--radix-popover-content-available-height);
  overflow-y: auto;
  background: ${p => p.theme.colors.bg};
`;
