import { useEffect, useId, useState, type JSX } from 'react';
import { useSaveState, useTitle, type Resource } from '@tomic/react';
import * as RadixPopover from '@radix-ui/react-popover';
import {
  FaCheck,
  FaCircleExclamation,
  FaClock,
  FaDesktop,
  FaServer,
  FaVault,
  FaArrowUp,
  FaShareNodes,
} from 'react-icons/fa6';
import { styled } from 'styled-components';
import { setLightness } from 'polished';
import { presetColors } from '../../styling';
import { IconButton } from '../IconButton/IconButton';
import { Popover } from '../Popover';
import { useResourceCopies } from './useResourceCopies';
import {
  resourceSyncPresentation,
  type SyncSymbol,
  type SyncTone,
} from './resourceSyncPresentation';
type PanelModule = typeof import('./ResourceSyncPanel');
let panelModulePromise: Promise<PanelModule> | undefined;

function loadPanel(): Promise<PanelModule> {
  panelModulePromise ??= import('./ResourceSyncPanel');

  return panelModulePromise;
}

/** A resource's own confirmed copies, separate from drive connection status. */
export function ResourceSyncIndicator({
  resource,
}: {
  resource: Resource;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [panelModule, setPanelModule] = useState<PanelModule>();
  const [loadError, setLoadError] = useState<unknown>();
  const opening = open && !panelModule;
  const ResourceSyncPanel = panelModule?.ResourceSyncPanel;

  useEffect(() => {
    if (!open || panelModule) return;
    let active = true;
    void loadPanel().then(
      module => {
        if (active) setPanelModule(module);
      },
      error => {
        if (active) setLoadError(error);
      },
    );

    return () => {
      active = false;
    };
  }, [open, panelModule]);
  const [title] = useTitle(resource);
  const { status, vault, peers, contents } = useResourceCopies(resource);
  const save = useSaveState(resource);
  const presentation = resourceSyncPresentation(
    status,
    save,
    vault,
    peers,
    contents,
  );
  const headingId = useId();
  if (loadError) throw loadError;

  return (
    <Root onClick={event => event.stopPropagation()} data-resource-sync>
      <SyncPopover
        aria-labelledby={headingId}
        open={open && !!ResourceSyncPanel}
        onOpenChange={next => setOpen(opening ? false : next)}
        noLock
        Trigger={
          <RadixPopover.Trigger asChild>
            <SyncButton
              type='button'
              title={opening ? 'Loading' : presentation.label}
              aria-busy={opening || undefined}
              onKeyDown={event => {
                if (event.key === 'Escape' && opening) setOpen(false);
              }}
              aria-label={`Copies and sync for ${title}: ${presentation.label}`}
              data-testid='resource-sync-indicator'
              data-sync-state={
                status.server.state === 'not-configured'
                  ? 'not-configured'
                  : (status.server.stored ?? 'unknown')
              }
              data-server-accepted-state={status.server.accepted}
              data-vault-sync-state={vault.state}
              data-peer-sync-state={peers.state}
              data-content-required={contents.required}
              data-content-local-state={contents.local.state}
              data-content-server-state={contents.server.state}
              data-content-vault-state={contents.vault.state}
              $tone={presentation.tone}
            >
              <StatusSymbol symbol={presentation.symbol} />
              {(presentation.tone === 'confirmed' ||
                presentation.tone === 'peer') && (
                <CheckMark aria-hidden>
                  <FaCheck />
                </CheckMark>
              )}
            </SyncButton>
          </RadixPopover.Trigger>
        }
      >
        {open && ResourceSyncPanel && (
          <ResourceSyncPanel
            resource={resource}
            status={status}
            vault={vault}
            peers={peers}
            contents={contents}
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
    case 'vault':
      return <FaVault aria-hidden />;
    case 'peer':
      return <FaShareNodes aria-hidden />;
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
    p.$tone === 'peer'
      ? setLightness(p.theme.darkMode ? 0.75 : 0.44, presetColors[5])
      : p.$tone === 'confirmed'
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
