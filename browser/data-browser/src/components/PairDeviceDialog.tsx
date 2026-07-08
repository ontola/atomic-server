import { useEffect, useMemo, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { renderSVG } from 'uqr';
import { encodePairingEnvelope, type PairingEnvelope } from '@tomic/lib';
import { Dialog, DialogContent, DialogTitle, useDialog } from './Dialog';
import { Button } from './Button';
import { useSettings } from '../helpers/AppSettings';
import { getAgentSecretFromIDB } from '../helpers/agentStorage';

interface PairDeviceDialogProps {
  /** This node's Iroh identity: `did:ad:node:<64 hex>`. */
  nodeDid: string;
  show: boolean;
  bindShow: (show: boolean) => void;
}

/**
 * Renders the `atomic://pair` QR codes from planning/device-pairing.md.
 * Two kinds behind one dialog:
 *
 * - **pair** (default, safe): routing only. Scanning it merely tells the
 *   other device where this node lives; the peer still has to prove the
 *   same agent key over AUTH before it receives anything.
 * - **onboard** (opt-in, blurred until pressed): routing **plus the agent
 *   secret** — a bearer credential with the same sensitivity as the
 *   copy-secret button in agent settings. For setting up a device that
 *   doesn't have the account yet.
 */
export function PairDeviceDialog({
  nodeDid,
  show,
  bindShow,
}: PairDeviceDialogProps): JSX.Element {
  const { baseURL } = useSettings();
  const [dialogProps, showDialog] = useDialog({ bindShow });
  const [revealOnboard, setRevealOnboard] = useState(false);
  const [agentSecret, setAgentSecret] = useState<string>();

  useEffect(() => {
    if (show) {
      setRevealOnboard(false);
      showDialog();
      getAgentSecretFromIDB()
        .then(setAgentSecret)
        .catch(() => setAgentSecret(undefined));
    }
  }, [show]);

  // A LAN/WS fast path is only worth advertising when another device could
  // actually reach it — localhost never resolves to this machine elsewhere.
  const urlHint = useMemo(() => {
    try {
      const parsed = new URL(baseURL);

      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
        ? undefined
        : baseURL;
    } catch {
      return undefined;
    }
  }, [baseURL]);

  const pairSvg = useMemo(() => {
    const envelope: PairingEnvelope = {
      v: 1,
      kind: 'pair',
      node: nodeDid,
      ...(urlHint ? { url: urlHint } : {}),
      drives: '*',
    };

    return renderSVG(encodePairingEnvelope(envelope));
  }, [nodeDid, urlHint]);

  const onboardSvg = useMemo(() => {
    if (!show || !agentSecret) {
      return undefined;
    }

    const envelope: PairingEnvelope = {
      v: 1,
      kind: 'onboard',
      secret: agentSecret,
      node: nodeDid,
      ...(urlHint ? { url: urlHint } : {}),
      drives: '*',
    };

    return renderSVG(encodePairingEnvelope(envelope));
  }, [show, agentSecret, nodeDid, urlHint]);

  if (!show) {
    return <></>;
  }

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h1>Pair a device</h1>
      </DialogTitle>
      <DialogContent>
        <Columns>
          <Column>
            <h2>Device with your account</h2>
            <Explainer>
              Scan from another device that is already signed in as you. The
              code only says where to find this node — the other device still
              has to prove it holds your key.
            </Explainer>
            <QrBox dangerouslySetInnerHTML={{ __html: pairSvg }} />
          </Column>
          {onboardSvg && (
            <Column>
              <h2>New device setup</h2>
              <Explainer>
                This code contains your account secret. Anyone who scans it
                becomes you — reveal it only when the new device is ready to
                scan.
              </Explainer>
              <QrReveal>
                <QrBox
                  aria-hidden={!revealOnboard}
                  $blurred={!revealOnboard}
                  dangerouslySetInnerHTML={{ __html: onboardSvg }}
                />
                {!revealOnboard && (
                  <RevealOverlay>
                    <Button onClick={() => setRevealOnboard(true)}>
                      Reveal setup code
                    </Button>
                  </RevealOverlay>
                )}
              </QrReveal>
            </Column>
          )}
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
  flex-grow: 1;
`;

const QrBox = styled.div<{ $blurred?: boolean }>`
  width: 13rem;
  height: 13rem;
  border-radius: ${p => p.theme.radius};
  overflow: hidden;
  background: white;
  padding: 0.5rem;
  filter: ${p => (p.$blurred ? 'blur(14px)' : 'none')};
  transition: filter 0.15s ease;

  svg {
    width: 100%;
    height: 100%;
    display: block;
  }
`;

const QrReveal = styled.div`
  position: relative;
  width: fit-content;
`;

const RevealOverlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
`;
