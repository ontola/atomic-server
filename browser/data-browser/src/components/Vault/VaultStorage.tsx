import { useCallback, useState } from 'react';
import { styled } from 'styled-components';
import { Button } from '../Button';
import { CARD_SUB_FONT } from '../cardSurface';
import {
  freeUpVaultStorage,
  getVaultUsage,
  type VaultUsage,
} from '../../helpers/managed/vault';

/**
 * What a drive's Cloud Vault storage is made of, and what can be freed.
 *
 * The host is blind, so the breakdown is by kind of object rather than by file
 * or note. Two amounts are kept apart on purpose: what is safe to free (old
 * history nothing needs) and what is only kept so a recent deletion can be
 * undone. The second is never freed without a separate, explicit choice.
 */
export function VaultStorage({
  drivePseudonym,
  onChanged,
}: {
  drivePseudonym: string;
  /** Called after storage was freed, so the host can refresh its numbers. */
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<VaultUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setUsage(await getVaultUsage(drivePseudonym));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read storage use.');
    }
  }, [drivePseudonym]);

  async function free(includeUndoWindow: boolean) {
    setBusy(true);
    setMessage(null);

    try {
      const result = await freeUpVaultStorage(
        drivePseudonym,
        includeUndoWindow,
      );

      setMessage(
        result.bytes_reclaimed > 0
          ? `Freed ${formatBytes(result.bytes_reclaimed)}.`
          : 'Nothing to free.',
      );
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not free storage.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Link
        type='button'
        data-testid='vault-manage-storage'
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        Manage storage
      </Link>
    );
  }

  return (
    <Wrapper data-testid='vault-storage'>
      <Heading>Storage in Cloud Vault</Heading>
      {error && (
        <ErrorText data-testid='vault-storage-error'>{error}</ErrorText>
      )}
      {!usage && !error && <Muted>Reading what is stored…</Muted>}
      {usage && (
        <>
          <Muted data-testid='vault-storage-total'>
            {formatBytes(usage.used_bytes)} of {formatBytes(usage.quota_bytes)}{' '}
            used
          </Muted>
          <Rows>
            {usage.by_kind.map(row => (
              <Row key={row.kind} data-testid={`vault-storage-${row.kind}`}>
                <span>
                  {kindLabel(row.kind)}
                  <Muted as='span'> · {kindHint(row.kind)}</Muted>
                </span>
                <span>{formatBytes(row.bytes)}</span>
              </Row>
            ))}
            {usage.pending_bytes > 0 && (
              <Row>
                <span>Uploads in progress</span>
                <span>{formatBytes(usage.pending_bytes)}</span>
              </Row>
            )}
            {usage.unaccounted_bytes > 0 && (
              <Row>
                <span>
                  Leftovers
                  <Muted as='span'> · cleaned up automatically</Muted>
                </span>
                <span>{formatBytes(usage.unaccounted_bytes)}</span>
              </Row>
            )}
          </Rows>

          {usage.reclaimable_bytes > 0 && (
            <Block>
              <span data-testid='vault-storage-reclaimable'>
                {formatBytes(usage.reclaimable_bytes)} of old history and unused
                files can be removed. Nothing you can see is lost.
              </span>
              <Button
                data-testid='vault-free-up'
                onClick={() => free(false)}
                disabled={busy}
              >
                {busy ? 'Freeing…' : 'Free up space'}
              </Button>
            </Block>
          )}

          {usage.undo_window_bytes > 0 && (
            <Block>
              <span data-testid='vault-storage-undo'>
                {formatBytes(usage.undo_window_bytes)} is kept only so recently
                deleted items can be brought back. Freeing it means those cannot
                be restored.
              </span>
              <Button
                data-testid='vault-free-up-undo'
                subtle
                onClick={() => free(true)}
                disabled={busy}
              >
                Free it anyway
              </Button>
            </Block>
          )}

          {usage.reclaimable_bytes === 0 && usage.undo_window_bytes === 0 && (
            <Muted data-testid='vault-storage-nothing'>
              Nothing extra is stored. This is what your workspace needs.
            </Muted>
          )}
        </>
      )}
      {message && <Muted data-testid='vault-storage-message'>{message}</Muted>}
      <Link type='button' onClick={() => setOpen(false)}>
        Hide
      </Link>
    </Wrapper>
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'pack':
      return 'Change history';
    case 'checkpoint':
    case 'checkpoint_image':
      return 'Snapshots';
    case 'blob':
      return 'Files and images';
    case 'index':
      return 'Search index';
    case 'dictionary':
      return 'Compression data';
    default:
      return 'Other';
  }
}

function kindHint(kind: string): string {
  switch (kind) {
    case 'pack':
      return 'every edit since your last snapshot';
    case 'checkpoint':
    case 'checkpoint_image':
      return 'full copies used to restore quickly';
    case 'blob':
      return 'uploads attached to your pages';
    default:
      return 'supporting data';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.4rem;
  padding-top: 0.6rem;
  border-top: 1px solid ${p => p.theme.colors.bg2};
  font-size: ${CARD_SUB_FONT};
`;

const Heading = styled.strong`
  font-size: ${CARD_SUB_FONT};
`;

const Muted = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: ${CARD_SUB_FONT};
`;

const Rows = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
`;

const Row = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 1rem;
`;

const Block = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
`;

const ErrorText = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.alert};
`;

const Link = styled.button`
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: ${p => p.theme.colors.main};
  font-size: ${CARD_SUB_FONT};
  text-decoration: underline;
  cursor: pointer;
`;
