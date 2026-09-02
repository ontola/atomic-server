import React, { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaMobileScreenButton, FaLock } from 'react-icons/fa6';
import { useStore } from '@tomic/react';
import { useDriveVault } from '../../helpers/managed/useDriveVault';
import { listVaultDrives } from '../../helpers/managed/vault';
import { Button } from '../../components/Button';
import { Column, Row } from '../../components/Row';
import { PairingCode } from '../../components/PairingCode';
import { ConnectToDeviceForm } from '../../components/ConnectToDeviceForm';
import { InputStyled, InputWrapper } from '../../components/forms/InputStyles';
import { useOwnNodeDid } from '../../hooks/useOwnNodeDid';
import {
  usePairingFlow,
  type WorkspaceResult,
} from '../../components/pairing/PairingFlowProvider';
import { useSettings } from '../../helpers/AppSettings';
import { deviceHasDriveData } from '../../helpers/driveData';
import { fetchPrivateDriveSubject } from '../../helpers/privateDrive';
import { fetchManagedInfo } from '../../helpers/managedServer';
import { normalizeServerUrl, serverLabel } from '../../helpers/serverUrl';
import { isRunningInTauri } from '../../helpers/tauri';
import {
  CardSubtitle,
  CardTitle,
  OnboardingCard,
  OnboardingWrap,
  FooterBar,
} from './chrome';

/**
 * `/iroh-sync` answers as soon as the peer's push is imported, which is not the
 * same moment the drive becomes fetchable — and a paired peer may also deliver
 * it a beat later over the live connection. Checking once raced that and told
 * people their workspace wasn't there while it was landing.
 *
 * So poll, and poll long enough that giving up means something. The dialog
 * shows a spinner throughout, and a stated reason after.
 */
const DRIVE_WAIT_MS = 30_000;
const DRIVE_POLL_INTERVAL_MS = 1_000;

/** How often to look while a code is on screen, waiting for a scan to push. */
const WATCH_INTERVAL_MS = 3_000;

interface ConnectDeviceStepProps {
  /** The drive that should be here but isn't. Absent if none resolved. */
  drive?: string;
  /** Enter the app anyway, without its data. */
  onSkip: () => void;
  /** The drive's data arrived — open it. */
  onConnected: (drive: string) => void;
}

/**
 * Shown right after signing in on a device that holds none of the account's
 * data. A secret restores *who you are*, not *what you have*: the workspace
 * still lives on whichever device made it, and the only way across is to reach
 * that device.
 *
 * Both directions of the QR work, because a peer sync reconciles both ways:
 * scan the other device's code from here (phones have the camera), or let the
 * other device scan the code shown here (desktops don't). Either way this
 * device ends up holding the drive.
 *
 * A plain browser tab has no node of its own, so it shows the code of the
 * always-on device it reads from: scanning that from the device holding the
 * workspace syncs it there, and this reads it from there. Same code, same
 * component, as the Sync page — a person who has seen one has seen both.
 */
export function ConnectDeviceStep({
  drive,
  onSkip,
  onConnected,
}: ConnectDeviceStepProps): JSX.Element {
  const store = useStore();
  const { agent, baseURL, setServer } = useSettings();
  const nodeDid = useOwnNodeDid();
  const isNode = isRunningInTauri();
  const startPairing = usePairingFlow();
  const [serverInput, setServerInput] = useState('');
  /**
   * The node another device should reach to put the workspace within this
   * browser's reach. A browser is not a node, so it shows the code of the
   * always-on device it reads from: scanning that syncs the workspace there,
   * and this reads it from there. Same code the Sync page shows.
   */
  const [reachableNodeDid, setReachableNodeDid] = useState<string>();

  /**
   * The drive we should open. Re-resolved rather than trusted: on a device that
   * held nothing, the agent's personal drive may only become knowable once the
   * agent resource itself has been pulled across.
   */
  async function resolveDriveSubject(): Promise<string | undefined> {
    return (
      drive ??
      (agent
        ? await fetchPrivateDriveSubject(store, agent).catch(() => undefined)
        : undefined)
    );
  }

  /**
   * The same subject, in state, because asking the vault about a drive needs a
   * value during render rather than a promise.
   */
  const [vaultDrive, setVaultDrive] = useState<string | undefined>(drive);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const local = await resolveDriveSubject();

      if (cancelled) return;

      if (local) {
        setVaultDrive(local);

        return;
      }

      // Nothing locally, and `fetchPrivateDriveSubject` asks a *server* which
      // a device holding nothing may not have — the desktop and Android apps
      // embed their own, empty one. The control plane knows which drives this
      // account has backed up, and asking it is the whole point of arriving
      // with nothing: without this the restore offer never appears on exactly
      // the device that needs it.
      try {
        const enrolled = await listVaultDrives();
        const backed = enrolled.find(e => e.status === 'active') ?? enrolled[0];

        if (!cancelled && backed) setVaultDrive(backed.drive_subject);
      } catch {
        // No session, or no control plane at all. Nothing to offer, which the
        // panel renders as nothing rather than as an error.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [drive, agent?.subject]);

  const vault = useDriveVault(vaultDrive ?? null);
  // Only offer this when there is something to restore. Backup being on with
  // nothing stored yet is a dead end, and an empty vault would return zero
  // resources and leave the screen looking like it failed.
  const canRestoreFromVault =
    vault.status.state === 'on' && vault.status.details.confirmed_objects > 0;

  async function restoreFromVault() {
    const outcome = await vault.restore();

    // `restore` reports its own failure through `vault.error`, which is
    // rendered below; there is nothing to navigate to if it did not work.
    if (outcome && vaultDrive) onConnected(vaultDrive);
  }

  /** One look — for the "did connecting a server fix this?" check below. */
  async function driveIsHere(): Promise<string | undefined> {
    const candidate = await resolveDriveSubject();

    if (!candidate) {
      return undefined;
    }

    return (await deviceHasDriveData(store, candidate, { refresh: true }))
      ? candidate
      : undefined;
  }

  /** Wait for the drive to land, and say why when it doesn't. */
  async function awaitWorkspace(): Promise<WorkspaceResult> {
    const candidate = await resolveDriveSubject();

    if (!candidate) {
      return { ok: false, reason: 'unknown-drive' };
    }

    const deadline = Date.now() + DRIVE_WAIT_MS;

    for (;;) {
      // The store cached a failed fetch of this drive a moment ago (that's how
      // we got here); ask the server again now that the sync has filled it in.
      if (await deviceHasDriveData(store, candidate, { refresh: true })) {
        return { ok: true, drive: candidate };
      }

      if (Date.now() >= deadline) {
        return { ok: false, reason: 'timeout' };
      }

      await new Promise(resolve => setTimeout(resolve, DRIVE_POLL_INTERVAL_MS));
    }
  }

  // Connecting a server is the browser's route out of here, and it can put the
  // drive back in reach. Notice that, rather than leaving the user on a screen
  // whose problem they just solved.
  useEffect(() => {
    if (isNode) {
      return;
    }

    let cancelled = false;

    void driveIsHere().then(arrived => {
      if (!cancelled && arrived) {
        onConnected(arrived);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [baseURL]);

  useEffect(() => {
    if (isNode || !baseURL) return;

    let cancelled = false;

    void fetchManagedInfo(baseURL).then(info => {
      if (!cancelled && info.nodeId) setReachableNodeDid(info.nodeId);
    });

    return () => {
      cancelled = true;
    };
  }, [baseURL, isNode]);

  // A scan pushes from the other device, which changes nothing here to react
  // to — so watch. Without this the workspace lands and the screen sits there,
  // still asking for it.
  useEffect(() => {
    if (isNode || !reachableNodeDid) return;

    let cancelled = false;

    const timer = setInterval(async () => {
      const arrived = await driveIsHere();

      if (!cancelled && arrived) {
        clearInterval(timer);
        onConnected(arrived);
      }
    }, WATCH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reachableNodeDid, isNode]);

  function connectWithCode(code: string) {
    // The dialog owns the progress and the outcome from here: connect, then
    // wait for the workspace to actually land, then offer to open it.
    startPairing(code, {
      drive,
      awaitWorkspace,
      onWorkspaceReady: onConnected,
    });
  }

  const otherDeviceRoutes = isNode ? (
    <>
      <Section>
        <SectionTitle>Connect to that device</SectionTitle>
        <Explainer>
          Open <strong>Sync</strong> there to show its code, then scan or paste
          it here.
        </Explainer>
        <ConnectToDeviceForm onCode={connectWithCode} />
      </Section>

      {nodeDid && (
        <Section>
          <SectionTitle>…or let it scan this device</SectionTitle>
          <Explainer>
            Scan this code from your other device instead. It only says where to
            reach this one — the other side still proves it holds your key.
          </Explainer>
          <QrRow>
            <PairingCode nodeDid={nodeDid} />
          </QrRow>
        </Section>
      )}
    </>
  ) : (
    <>
      {reachableNodeDid && (
        <Section>
          <SectionTitle>Scan this from that device</SectionTitle>
          <Explainer>
            Syncs your workspace with {serverLabel(baseURL)}, which this browser
            reads from. Safe to show: a code only routes.
          </Explainer>
          <QrRow>
            <PairingCode nodeDid={reachableNodeDid} />
          </QrRow>
        </Section>
      )}

      <Section>
        <SectionTitle>
          {reachableNodeDid
            ? '…or read it from somewhere else'
            : 'Connect a device that has it'}
        </SectionTitle>
        <Explainer>
          An always-on device has an address — add it and your workspace
          appears.
        </Explainer>
        <form
          onSubmit={(e: React.FormEvent) => {
            e.preventDefault();

            const url = normalizeServerUrl(serverInput);

            if (url) setServer(url);
          }}
        >
          <Row gap='0.5rem'>
            <InputWrapper>
              <InputStyled
                autoComplete='off'
                placeholder='localhost:9883 or your-server.example'
                value={serverInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setServerInput(e.target.value)
                }
              />
            </InputWrapper>
            <Button type='submit' subtle disabled={!serverInput.trim()}>
              Connect
            </Button>
          </Row>
        </form>
      </Section>
    </>
  );

  return (
    <OnboardingWrap>
      <OnboardingCard>
        <Column gap='1rem'>
          <Badge>
            {canRestoreFromVault ? (
              <FaLock aria-hidden />
            ) : (
              <FaMobileScreenButton aria-hidden />
            )}
          </Badge>
          <CardTitle>
            {canRestoreFromVault
              ? 'Restore this workspace'
              : 'Your data is on another device'}
          </CardTitle>
          <CardSubtitle>
            {canRestoreFromVault
              ? // The default copy below says the data stays where it was made,
                // which is exactly wrong for someone with an encrypted backup:
                // theirs is also in the vault, sealed, and restorable right
                // here. Telling them otherwise sends them hunting for a second
                // device they may no longer have.
                'You’re signed in, and this workspace has an encrypted backup. We stored it sealed, so only this device can open it.'
              : 'You’re signed in, but this device doesn’t have your workspace yet. Signing in restores who you are — your data stays where you made it.'}
          </CardSubtitle>

          {/* First, because it is the only route that needs nothing but this
              device. Everything below wants a second device that is switched
              on and reachable — which, for someone restoring after losing one,
              may not exist. */}
          {canRestoreFromVault && (
            <VaultOffer data-testid='vault-restore-offer'>
              {/* No heading: the card's own title and subtitle already say what
                  this is, and repeating it in a third register reads like two
                  different offers. */}
              {vault.error && <ErrorText role='alert'>{vault.error}</ErrorText>}
              {vault.restoreProgress !== null && (
                <Explainer>
                  Restoring… {Math.round(vault.restoreProgress * 100)}%
                </Explainer>
              )}
              <Row gap='0.5rem'>
                <Button
                  type='button'
                  data-testid='vault-restore-now'
                  onClick={restoreFromVault}
                  disabled={vault.busy}
                >
                  {vault.busy ? 'Restoring…' : 'Restore my workspace'}
                </Button>
              </Row>
            </VaultOffer>
          )}

          {canRestoreFromVault ? (
            /* Demoted, not removed. Someone with a backup should see one
               obvious action, but the second-device routes are still the
               answer for a workspace that was never backed up, or a vault
               whose most recent changes were made elsewhere. */
            <OtherRoutes>
              <OtherRoutesSummary>
                …or bring it from another device instead
              </OtherRoutesSummary>
              {otherDeviceRoutes}
            </OtherRoutes>
          ) : (
            otherDeviceRoutes
          )}
        </Column>
      </OnboardingCard>

      <FooterBar>
        <Button subtle type='button' onClick={onSkip}>
          Skip for now
        </Button>
      </FooterBar>
    </OnboardingWrap>
  );
}

const Badge = styled.div`
  align-self: center;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.3rem;
  color: ${p => p.theme.colors.main};
  background: ${p => p.theme.colors.main}1c;
`;

const Section = styled.section`
  display: flex;
  flex-direction: column;
`;

const SectionTitle = styled.h3`
  font-size: 1rem;
  margin: 0 0 0.3rem;
`;

const Explainer = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
  margin: 0 0 0.6rem;
`;

/** Centred, to sit under the card's centred title rather than beside it. */
const VaultOffer = styled.section`
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
`;

const ErrorText = styled.p`
  color: ${p => p.theme.colors.alert};
  font-size: 0.85rem;
  margin: 0 0 0.6rem;
`;

/**
 * The second-device routes, folded away when a vault restore is on offer.
 *
 * A `details` rather than state: it needs no JS, keyboard and screen-reader
 * behaviour come for free, and the content stays in the DOM so nothing about
 * it is actually hidden from someone looking for it.
 */
const OtherRoutes = styled.details`
  display: flex;
  flex-direction: column;
`;

const OtherRoutesSummary = styled.summary`
  cursor: pointer;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
  text-align: center;
  padding: 0.4rem 0;
  margin-bottom: 0.4rem;

  &:hover {
    color: ${p => p.theme.colors.text};
  }
`;

const QrRow = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  min-width: 0;
`;
