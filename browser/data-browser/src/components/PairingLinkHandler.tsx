import { useEffect, useEffectEvent, type JSX } from 'react';
import { clearDeepLinkSink, setDeepLinkSink } from '../helpers/deepLinkQueue';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { usePairingFlow } from './pairing/PairingFlowProvider';
import { parseDidOpenInput, resolveDidForOpen } from '../helpers/didResolve';
import { useSettings } from '../helpers/AppSettings';
import { useStore } from '@tomic/react';

/** The `atomic://open` host: an "open this resource" deep link. */
const OPEN_LINK_PREFIX = 'atomic://open';

/**
 * Consumes deep links forwarded by the Tauri shell (queued by
 * helpers/deepLinkQueue.ts) and routes them:
 *
 * - `atomic://open?subject=…&agent=…&node=…` opens a resource (resolving via
 *   pkarr / known peers when needed).
 * - Bare `did:ad:…` resource DIDs (with optional query hints) also open —
 *   Android may deliver these when the `did` scheme is registered.
 * - `atomic://pair` and bare `did:ad:node:` go to the pairing flow.
 *
 * We deliberately do **not** register the bare `did` scheme on iOS/desktop
 * (that would claim every DID method). `atomic://` is the OS-registered
 * scheme; `did:ad:` is accepted when the OS or another app hands it to us.
 */
export function PairingLinkHandler(): JSX.Element {
  const startPairing = usePairingFlow();
  const navigate = useNavigateWithTransition();
  const { drive } = useSettings();
  const store = useStore();

  const handleLink = useEffectEvent((uri: string) => {
    // Open links — atomic://open or a resource DID with optional hints.
    if (uri.startsWith(OPEN_LINK_PREFIX) || looksLikeResourceDid(uri)) {
      const target = parseDidOpenInput(uri);

      if (target) {
        void (async () => {
          await resolveDidForOpen(target.subject, {
            drive,
            agent: target.agent,
            node: target.node,
            tryPeers: !target.node && !target.agent,
            isAvailable: async subject => {
              try {
                const resource = await store.getResource(subject);

                return !resource.error;
              } catch {
                return false;
              }
            },
          });
          navigate(constructOpenURL(target.subject));
        })();
      }

      return;
    }

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

function looksLikeResourceDid(uri: string): boolean {
  if (!uri.startsWith('did:ad:')) {
    return false;
  }

  // Node DIDs without query params are pairing codes.
  if (uri.startsWith('did:ad:node:') && !uri.includes('?')) {
    return false;
  }

  return parseDidOpenInput(uri) !== null;
}
