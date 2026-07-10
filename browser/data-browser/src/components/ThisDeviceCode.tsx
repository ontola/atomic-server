import { useMemo, type JSX } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { renderSVG } from 'uqr';
import { encodePairingEnvelope, type PairingEnvelope } from '@tomic/lib';
import { Button } from './Button';
import { useSettings } from '../helpers/AppSettings';

interface ThisDeviceCodeProps {
  /** This node's Iroh identity: `did:ad:node:<64 hex>`. */
  nodeDid: string;
}

/**
 * This device's `atomic://pair` code, as a QR and as copyable text, for
 * another device to scan or paste.
 *
 * The code is **routing only** — it says where to reach this device, and
 * nothing more. Whoever dials still has to prove they hold the same agent key
 * over AUTH, so this is safe to show on screen.
 */
export function ThisDeviceCode({ nodeDid }: ThisDeviceCodeProps): JSX.Element {
  const { baseURL } = useSettings();

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

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(pairUri);
      toast.success('Pairing code copied.');
    } catch {
      toast.error('Could not copy — select and copy the code manually.');
    }
  };

  return (
    <>
      <QrBox dangerouslySetInnerHTML={{ __html: pairSvg }} />
      <CodeRow>
        <CodeText title={pairUri}>{pairUri}</CodeText>
        <Button subtle onClick={copyCode}>
          Copy
        </Button>
      </CodeRow>
    </>
  );
}

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

const QrBox = styled.div`
  width: 13rem;
  height: 13rem;
  max-width: 100%;
  border-radius: ${p => p.theme.radius};
  overflow: hidden;
  background: white;
  padding: 0.5rem;
  box-sizing: border-box;

  svg {
    width: 100%;
    height: 100%;
    display: block;
  }
`;
