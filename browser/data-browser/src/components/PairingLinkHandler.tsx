import { useEffect, useEffectEvent, type JSX } from 'react';
import toast from 'react-hot-toast';
import { useNavigate } from '@tanstack/react-router';
import {
  decodePairingEnvelope,
  PairingEnvelopeError,
  type PairingEnvelope,
} from '@tomic/lib';
import { useStore } from '@tomic/react';
import { clearDeepLinkSink, setDeepLinkSink } from '../helpers/deepLinkQueue';
import { upsertKnownPeer } from '../helpers/knownPeers';
import { pairAndSync } from '../helpers/pairing';
import { paths } from '../routes/paths';

/**
 * Consumes scanned/tapped `atomic://pair` deep links (forwarded by the Tauri
 * shell, queued by helpers/deepLinkQueue.ts): persist a KnownPeer, start a
 * sync, and show the Sync page.
 *
 * A pairing code is routing only, so this can act on one without asking. It
 * grants nothing — the dialed peer still has to pass same-agent AUTH — and a
 * code that tries to carry an identity is refused by the decoder. That refusal
 * is what makes acting-without-asking safe here: `atomic://` links can be fired
 * by any app or web page, not just by the camera, so a link must never be able
 * to sign this device in as someone else.
 */
export function PairingLinkHandler(): JSX.Element {
  const store = useStore();
  const navigate = useNavigate();

  /**
   * Record the peer, then pull its copy of the current drive right away —
   * pairing should *sync*, not just store an address. Best-effort: the peer may
   * be unreachable or hold a different agent (AUTH refuses). The peer is
   * recorded either way, so Sync → Peers offers a manual retry.
   */
  async function kickInitialSync(nodeDid: string) {
    const drive = store.getSyncStatus().drive;

    try {
      const outcome = await pairAndSync(nodeDid, drive);

      if (outcome) {
        toast.success(
          `Synced ${outcome.count} resources with the paired device.`,
        );
      }
    } catch (e) {
      toast.error(
        e instanceof Error
          ? `Could not sync yet: ${e.message}`
          : 'Could not reach the paired device yet — retry under Sync → Peers.',
      );
    }
  }

  const handleLink = useEffectEvent((uri: string) => {
    // Deep links from the OS always arrive as `atomic://…`. The Sync page's
    // paste field feeds this same pipeline, and there a bare node DID is a
    // legitimate (routing-only) code.
    if (!uri.startsWith('atomic://') && !uri.startsWith('did:ad:node:')) {
      return;
    }

    let envelope: PairingEnvelope;

    try {
      envelope = decodePairingEnvelope(uri);
    } catch (e) {
      toast.error(
        e instanceof PairingEnvelopeError
          ? e.message
          : 'Could not read the pairing link.',
      );

      return;
    }

    upsertKnownPeer(envelope.node);
    toast.success('Device paired — starting a sync…');
    navigate({ to: paths.sync });
    void kickInitialSync(envelope.node);
  });

  useEffect(() => {
    const sink = (uri: string) => handleLink(uri);
    setDeepLinkSink(sink);

    return () => clearDeepLinkSink(sink);
  }, []);

  return <></>;
}
