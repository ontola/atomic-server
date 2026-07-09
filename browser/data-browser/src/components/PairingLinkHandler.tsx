import { useEffect, useEffectEvent, useState, type JSX } from 'react';
import toast from 'react-hot-toast';
import { useNavigate } from '@tanstack/react-router';
import {
  Agent,
  decodePairingEnvelope,
  PairingEnvelopeError,
  type PairingEnvelope,
} from '@tomic/lib';
import { useStore } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { clearDeepLinkSink, setDeepLinkSink } from '../helpers/deepLinkQueue';
import { upsertKnownPeer } from '../helpers/knownPeers';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { constructOpenURL } from '../helpers/navigation';
import { paths } from '../routes/paths';
import { ConfirmationDialog } from './ConfirmationDialog';

/** The agent subject an onboard envelope's secret resolves to, or undefined. */
function subjectOfSecret(secret: string): string | undefined {
  try {
    const parsed = JSON.parse(atob(secret)) as { subject?: unknown };

    return typeof parsed.subject === 'string' ? parsed.subject : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Consumes scanned/tapped `atomic://pair` deep links (forwarded by the Tauri
 * shell, queued by helpers/deepLinkQueue.ts):
 *
 * - `pair` — routing only: persist a KnownPeer and show the Sync page. The
 *   link grants nothing; the dialed peer still has to pass same-agent AUTH.
 * - `onboard` — routing + identity. Imported silently only when this device
 *   has no agent yet (that is the point of the flow); a device that already
 *   holds a *different* agent gets an explicit "switch account?" confirmation
 *   — never a silent key replacement.
 */
export function PairingLinkHandler(): JSX.Element {
  const store = useStore();
  const { agent, setAgent, setDrive } = useSettings();
  const navigate = useNavigate();
  const [pendingSwitch, setPendingSwitch] = useState<PairingEnvelope>();

  async function applyOnboard(envelope: PairingEnvelope) {
    if (!envelope.secret) {
      return;
    }

    const newAgent = await Agent.fromSecret(envelope.secret);
    setAgent(newAgent);
    await saveAgentToIDB(envelope.secret);
    upsertKnownPeer(envelope.node);

    const home = await fetchPersonalDriveSubject(store, newAgent).catch(
      () => undefined,
    );

    if (home) {
      setDrive(home);
      navigate({ to: constructOpenURL(home) });
    } else {
      navigate({ to: paths.sync });
    }

    toast.success('Device paired — you are signed in.');
  }

  const handleLink = useEffectEvent((uri: string) => {
    if (!uri.startsWith('atomic://')) {
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

    if (
      envelope.kind === 'pair' ||
      // An onboard link for the agent we already hold is just routing.
      (envelope.secret && subjectOfSecret(envelope.secret) === agent?.subject)
    ) {
      upsertKnownPeer(envelope.node);
      toast.success('Device paired — find it under Sync → Peers.');
      navigate({ to: paths.sync });

      return;
    }

    if (agent) {
      // Scanning an onboard code while already signed in is likely a
      // mistake — make switching identities an explicit choice.
      setPendingSwitch(envelope);

      return;
    }

    applyOnboard(envelope).catch(() => {
      toast.error('Could not read the identity in the pairing code.');
    });
  });

  useEffect(() => {
    const sink = (uri: string) => handleLink(uri);
    setDeepLinkSink(sink);

    return () => clearDeepLinkSink(sink);
  }, []);

  return (
    <ConfirmationDialog
      title='Switch account?'
      confirmLabel='Switch account'
      show={pendingSwitch !== undefined}
      bindShow={show => {
        if (!show) setPendingSwitch(undefined);
      }}
      onConfirm={() => {
        const envelope = pendingSwitch;
        setPendingSwitch(undefined);

        if (envelope) {
          applyOnboard(envelope).catch(() => {
            toast.error('Could not read the identity in the pairing code.');
          });
        }
      }}
      onCancel={() => setPendingSwitch(undefined)}
    >
      <p>
        This device is already signed in. The pairing code you scanned belongs
        to a different account — switching signs this device out of the current
        one. Make sure its passphrase is saved somewhere before you continue, or
        you lose access to that account.
      </p>
    </ConfirmationDialog>
  );
}
