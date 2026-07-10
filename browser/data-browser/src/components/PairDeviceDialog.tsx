import { useEffect, type JSX } from 'react';
import { styled } from 'styled-components';
import { Dialog, DialogContent, DialogTitle, useDialog } from './Dialog';
import { ThisDeviceCode } from './ThisDeviceCode';
import { ConnectToDeviceForm } from './ConnectToDeviceForm';
import { deliverDeepLink } from '../helpers/deepLinkQueue';
import { isMobileTauri } from '../helpers/tauri';

interface PairDeviceDialogProps {
  /** This node's Iroh identity: `did:ad:node:<64 hex>`. */
  nodeDid: string;
  show: boolean;
  bindShow: (show: boolean) => void;
}

/**
 * The device-sync surface (planning/device-pairing.md): show this device's
 * `atomic://pair` code (QR + copyable text) AND accept another device's code
 * to connect.
 *
 * The code is **routing only**. It merely tells the other device where this
 * node lives; the peer still proves it holds the same agent key over AUTH
 * before it receives anything. So both devices must already be signed in —
 * this dialog cannot hand an identity to a device that isn't, because the
 * agent's private key is non-extractable and cannot be read back out
 * (`helpers/agentStorage.ts`). Signing a new device in means entering the
 * secret the user saved during onboarding.
 */
export function PairDeviceDialog({
  nodeDid,
  show,
  bindShow,
}: PairDeviceDialogProps): JSX.Element {
  const [dialogProps, showDialog] = useDialog({ bindShow });

  useEffect(() => {
    if (show) {
      showDialog();
    }
  }, [show]);

  if (!show) {
    return <></>;
  }

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h1>Sync another device</h1>
      </DialogTitle>
      <DialogContent>
        <Columns>
          <Column>
            <h2>This device</h2>
            <Explainer>
              Scan this from a device already signed in as you, or copy the code
              and paste it there. It only says where to reach this device — the
              other side still proves it holds your key.
            </Explainer>
            <ThisDeviceCode nodeDid={nodeDid} />
            <Explainer>
              Not signed in on the other device yet? Sign in there with your
              account secret first, then pair.
            </Explainer>
          </Column>

          <Column>
            <h2>Connect to a device</h2>
            <Explainer>
              {isMobileTauri()
                ? 'Scan the other device’s QR code, or paste its pairing code, to start syncing.'
                : 'Paste a pairing code from your other device to start syncing.'}
            </Explainer>
            {/* Routes through the same handler a scanned deep link uses
                (PairingLinkHandler): validate, persist the peer, start a sync. */}
            <ConnectToDeviceForm
              onCode={code => {
                deliverDeepLink(code);
                bindShow(false);
              }}
            />
          </Column>
        </Columns>
      </DialogContent>
    </Dialog>
  );
}

const Columns = styled.div`
  display: flex;
  gap: 2rem;
  flex-wrap: wrap;

  h2 {
    font-size: 1rem;
    margin-bottom: 0.3rem;
  }
`;

const Column = styled.div`
  flex: 1;
  min-width: 15rem;
  max-width: 20rem;
  display: flex;
  flex-direction: column;
`;

const Explainer = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
`;
