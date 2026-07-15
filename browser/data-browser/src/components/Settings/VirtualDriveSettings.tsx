import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { FaCopy } from 'react-icons/fa6';
import { Button } from '../Button';
import { Column, Row } from '../Row';
import {
  getVirtualDriveStatus,
  startVirtualDrive,
  stopVirtualDrive,
  type VirtualDriveStatus,
} from '../../helpers/virtualDrive';

/**
 * Desktop-only: start/stop the read-only NFS virtual drive and surface the
 * `mount` command to attach it. Rendered only when `isVirtualDriveAvailable()`
 * (see the caller in AppSettings), so it can assume the Tauri commands exist.
 */
export function VirtualDriveSettings(): React.JSX.Element {
  const [status, setStatus] = useState<VirtualDriveStatus | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getVirtualDriveStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  const toggle = async () => {
    setBusy(true);
    const action = status?.running ? stopVirtualDrive : startVirtualDrive;
    const next = await action().catch((error: unknown) => {
      toast.error(`Virtual drive: ${error}`);

      return undefined;
    });

    if (next) {
      setStatus(next);
    }

    setBusy(false);
  };

  const copyMountCommand = () => {
    if (!status) {
      return;
    }

    navigator.clipboard.writeText(status.mount_command);
    toast.success('Mount command copied');
  };

  return (
    <Column gap='0.75rem'>
      <p>
        Mount your Atomic drives as a read-only folder on this computer, served
        over local NFS. Turn it on, then run the mount command in a terminal.
      </p>
      <Row center gap='1ch'>
        <Button onClick={toggle} disabled={busy}>
          {status?.running ? 'Stop virtual drive' : 'Start virtual drive'}
        </Button>
        <Status $running={!!status?.running}>
          {status?.running ? `Running on ${status.addr}` : 'Stopped'}
        </Status>
      </Row>
      {status?.running && (
        <MountCommand center gap='0.5ch'>
          <code>{status.mount_command}</code>
          <Button subtle onClick={copyMountCommand} title='Copy mount command'>
            <FaCopy />
          </Button>
        </MountCommand>
      )}
    </Column>
  );
}

const Status = styled.span<{ $running: boolean }>`
  color: ${p => (p.$running ? p.theme.colors.main : p.theme.colors.textLight)};
  font-weight: 500;
`;

const MountCommand = styled(Row)`
  background-color: ${p => p.theme.colors.bg1};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.4rem 0.6rem;

  code {
    flex: 1;
    overflow-x: auto;
    white-space: nowrap;
    font-family: monospace;
    font-size: 0.85rem;
  }
`;
