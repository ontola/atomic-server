import { useEffect, useEffectEvent, type JSX } from 'react';
import { clearDeepLinkSink, setDeepLinkSink } from '../helpers/deepLinkQueue';
import { usePairingFlow } from './pairing/PairingFlowProvider';

/**
 * Consumes scanned/tapped `atomic://pair` deep links (forwarded by the Tauri
 * shell, queued by helpers/deepLinkQueue.ts) and hands them to the pairing
 * flow, which shows its progress and reports what happened.
 *
 * A pairing code is routing only, so this can act on one without asking. It
 * grants nothing — the dialed peer still has to pass same-agent AUTH — and a
 * code that tries to carry an identity is refused when it's decoded. That
 * refusal is what makes acting-without-asking safe here: `atomic://` links can
 * be fired by any app or web page, not just by the camera, so a link must never
 * be able to sign this device in as someone else.
 */
export function PairingLinkHandler(): JSX.Element {
  const startPairing = usePairingFlow();

  const handleLink = useEffectEvent((uri: string) => {
    // Deep links from the OS always arrive as `atomic://…`. The Sync page's
    // paste field feeds this same pipeline, and there a bare node DID is a
    // legitimate (routing-only) code. Anything else isn't ours.
    if (!uri.startsWith('atomic://') && !uri.startsWith('did:ad:node:')) {
      return;
    }

    startPairing(uri);
  });

  useEffect(() => {
    const sink = (uri: string) => handleLink(uri);
    setDeepLinkSink(sink);

    return () => clearDeepLinkSink(sink);
  }, []);

  return <></>;
}
