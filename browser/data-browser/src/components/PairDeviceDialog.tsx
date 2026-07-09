import { useEffect, useMemo, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { renderSVG } from 'uqr';
import { encodePairingEnvelope, type PairingEnvelope } from '@tomic/lib';
import { Dialog, DialogContent, DialogTitle, useDialog } from './Dialog';
import { Button } from './Button';
import { useSettings } from '../helpers/AppSettings';
import { getAgentSecretFromIDB } from '../helpers/agentStorage';
import { deliverDeepLink } from '../helpers/deepLinkQueue';

interface PairDeviceDialogProps {
  /** This node's Iroh identity: `did:ad:node:<64 hex>`. */
  nodeDid: string;
  show: boolean;
  bindShow: (show: boolean) => void;
}

/**
 * The device-sync surface (planning/device-pairing.md): show this device's
 * `atomic://pair` code (QR + copyable text) AND accept another device's code
 * to connect. Two outgoing kinds:
 *
 * - **pair** (default, safe): routing only. It merely tells the other device
 *   where this node lives; the peer still proves the same agent key over
 *   AUTH before it receives anything.
 * - **onboard** (opt-in, blurred until pressed): routing **plus the agent
 *   secret** — a bearer credential with the same sensitivity as the
 *   copy-secret button in agent settings. For a device not signed in yet.
 *
 * A pasted incoming code is handed to the same handler a scanned deep link
 * uses (`PairingLinkHandler`), which persists the peer and starts a sync.
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
  const [incomingCode, setIncomingCode] = useState('');

  useEffect(() => {
    if (show) {
      setRevealOnboard(false);
      setIncomingCode('');
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

  const pairUri = useMemo(() => {
    const envelope: PairingEnvelope = {
      v: 1,
      kind: 'pair',
      node: nodeDid,
      ...(urlHint ? { url: urlHint } : {}),
      drives: '*',
    };

    return encodePairingEnvelope(envelope);
  }, [nodeDid, urlHint]);

  const pairSvg = useMemo(() => renderSVG(pairUri), [pairUri]);

  const onboardUri = useMemo(() => {
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

    return encodePairingEnvelope(envelope);
  }, [show, agentSecret, nodeDid, urlHint]);

  const onboardSvg = useMemo(
    () => (onboardUri ? renderSVG(onboardUri) : undefined),
    [onboardUri],
  );

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success('Pairing code copied.');
    } catch {
      toast.error('Could not copy — select and copy the code manually.');
    }
  };

  const connectWithCode = () => {
    const code = incomingCode.trim();

    if (!code) {
      return;
    }

    // Routes through the same handler a scanned deep link uses
    // (PairingLinkHandler): validate, persist the peer, start a sync.
    deliverDeepLink(code);
    bindShow(false);
  };

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
            <QrBox dangerouslySetInnerHTML={{ __html: pairSvg }} />
            <CodeRow>
              <CodeText title={pairUri}>{pairUri}</CodeText>
              <Button subtle onClick={() => copyCode(pairUri)}>
                Copy
              </Button>
            </CodeRow>

            {onboardSvg && onboardUri && (
              <>
                <h2>New device (not signed in yet)</h2>
                <Explainer>
                  This code carries your account secret — anyone who scans it
                  becomes you. Reveal it only with the new device ready.
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
                {revealOnboard && (
                  <CodeRow>
                    <CodeText title={onboardUri}>{onboardUri}</CodeText>
                    <Button subtle onClick={() => copyCode(onboardUri)}>
                      Copy
                    </Button>
                  </CodeRow>
                )}
              </>
            )}
          </Column>

          <Column>
            <h2>Connect to a device</h2>
            <Explainer>
              Paste a pairing code from your other device to start syncing. (Or
              scan its QR with your camera — that opens the app directly.)
            </Explainer>
            <ConnectForm
              onSubmit={e => {
                e.preventDefault();
                connectWithCode();
              }}
            >
              <CodeInput
                autoComplete='off'
                placeholder='Paste atomic://pair… code'
                value={incomingCode}
                onChange={e => setIncomingCode(e.target.value)}
              />
              <Button type='submit' disabled={!incomingCode.trim()}>
                Connect
              </Button>
            </ConnectForm>
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

const CodeRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.6rem;
  margin-bottom: 0.4rem;
  min-width: 0;
`;

const CodeText = styled.code`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
  background: ${p => p.theme.colors.bg1};
  padding: 0.35rem 0.5rem;
  border-radius: ${p => p.theme.radius};
`;

const ConnectForm = styled.form`
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
`;

const CodeInput = styled.input`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.5rem 0.6rem;
  font-size: 0.85rem;
  background: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  width: 100%;
  box-sizing: border-box;
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
