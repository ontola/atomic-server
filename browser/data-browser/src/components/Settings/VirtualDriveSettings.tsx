import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { FaFolderOpen } from 'react-icons/fa6';
import { Button } from '../Button';
import { Column, Row } from '../Row';
import {
  getVirtualDriveStatus,
  openVirtualDrive,
  startVirtualDrive,
  stopVirtualDrive,
  type VirtualDriveStatus,
} from '../../helpers/virtualDrive';

/**
 * Desktop-only: turn the virtual drive on/off. Starting it runs the local NFS
 * server and mounts your drives into the filesystem; stopping it unmounts. No
 * terminal needed. Rendered only when `isVirtualDriveAvailable()` (see the
 * caller in AppSettings), so it can assume the Tauri commands exist.
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
    const action = status?.mounted ? stopVirtualDrive : startVirtualDrive;
    const next = await action().catch((error: unknown) => {
      toast.error(`${error}`);

      return undefined;
    });

    if (next) {
      setStatus(next);
    }

    setBusy(false);
  };

  const open = () => {
    openVirtualDrive().catch((error: unknown) => toast.error(`${error}`));
  };

  return (
    <Column gap='0.75rem'>
      <p>
        Mount your Atomic drives as a folder on this computer. Your files,
        folders and documents show up in your file manager, and changes you make
        there sync back.
      </p>
      <Row center gap='1ch'>
        <Button onClick={toggle} disabled={busy}>
          {status?.mounted ? 'Turn off' : 'Turn on'}
        </Button>
        {status?.mounted && status.mount_path && (
          <>
            <Mounted>Mounted at {status.mount_path}</Mounted>
            <Button subtle onClick={open} title='Open in file manager'>
              <FaFolderOpen /> Open
            </Button>
          </>
        )}
      </Row>
    </Column>
  );
}

const Mounted = styled.span`
  color: ${p => p.theme.colors.main};
  font-weight: 500;
`;
