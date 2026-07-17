import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaMobileScreenButton } from 'react-icons/fa6';
import { useStore } from '@tomic/react';
import { Button } from '../../components/Button';
import { Column } from '../../components/Row';
import { PairingCode } from '../../components/PairingCode';
import { ConnectToDeviceForm } from '../../components/ConnectToDeviceForm';
import { ConnectServerDialog } from '../../components/ConnectServerDialog';
import { useOwnNodeDid } from '../../hooks/useOwnNodeDid';
import {
  usePairingFlow,
  type WorkspaceResult,
} from '../../components/pairing/PairingFlowProvider';
import { useSettings } from '../../helpers/AppSettings';
import { deviceHasDriveData } from '../../helpers/driveData';
import { fetchPersonalDriveSubject } from '../../helpers/personalDrive';
import { fetchManagedInfo } from '../../helpers/managedServer';
import { serverLabel } from '../../helpers/serverUrl';
import { serverURLStorage } from '../../helpers/serverURLStorage';
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

/**
 * How often to look while the code is on screen, waiting for the other device
 * to be scanned and push. Slower than the wait above, which runs for a bounded
 * 30s after a known action: this one runs for as long as someone leaves the
 * screen open, and every look is a fetch.
 */
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
 * server it is signed in to: the other device scans that, syncs the drive
 * there, and the browser reads it from somewhere it can reach. To the person
 * holding the phone that is still "bring my data to that screen", which is why
 * the copy talks about devices — the server is how it travels, not what this
 * is about.
 *
 * Connecting a different server stays on offer for the case that framing
 * doesn't cover: a workspace already synced somewhere else.
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
  const [showServerDialog, setShowServerDialog] = useState(false);

  /**
   * The drive we should open. Re-resolved rather than trusted: on a device that
   * held nothing, the agent's personal drive may only become knowable once the
   * agent resource itself has been pulled across.
   */
  async function resolveDriveSubject(): Promise<string | undefined> {
    return (
      drive ??
      (agent
        ? await fetchPersonalDriveSubject(store, agent).catch(() => undefined)
        : undefined)
    );
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

  /**
   * The node another device should reach to put the workspace within this
   * browser's reach. A browser is not a node, so the code shows the one it is
   * signed in to — scanning it there syncs the drive to somewhere this browser
   * can read, which is the whole of what "bring it here" means.
   */
  const [reachableNodeDid, setReachableNodeDid] = useState<string>();

  useEffect(() => {
    if (isNode || !baseURL) {
      return;
    }

    let cancelled = false;

    void fetchManagedInfo(baseURL).then(info => {
      if (!cancelled && info.nodeId) {
        setReachableNodeDid(info.nodeId);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [baseURL, isNode]);

  // The other device pushes when it scans, which changes nothing here to
  // react to — so watch for the workspace landing while the code is up.
  // Without this the data arrives and the screen sits there, still asking.
  useEffect(() => {
    if (isNode || !reachableNodeDid) {
      return;
    }

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

  return (
    <OnboardingWrap>
      <OnboardingCard>
        <Column gap='1rem'>
          <Badge>
            <FaMobileScreenButton aria-hidden />
          </Badge>
          <CardTitle>Your data is on another device</CardTitle>
          <CardSubtitle>
            You’re signed in, but this device doesn’t have your workspace yet.
            Signing in restores who you are — your data stays where you made it.
          </CardSubtitle>

          {isNode ? (
            <>
              <Section>
                <SectionTitle>Connect to that device</SectionTitle>
                <Explainer>
                  Open <strong>Sync</strong> there to show its code, then scan
                  or paste it here.
                </Explainer>
                <ConnectToDeviceForm onCode={connectWithCode} />
              </Section>

              {nodeDid && (
                <Section>
                  <SectionTitle>…or let it scan this device</SectionTitle>
                  <Explainer>
                    Scan this code from your other device instead. It only says
                    where to reach this one — the other side still proves it
                    holds your key.
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
                  <SectionTitle>Bring it here from that device</SectionTitle>
                  <Explainer>
                    Scan this code with the device that has your data. Your
                    workspace syncs across and opens here — the code only says
                    where to reach this browser, and the other side still proves
                    it holds your key.
                  </Explainer>
                  <QrRow>
                    <PairingCode nodeDid={reachableNodeDid} />
                  </QrRow>
                  <Aside>
                    Your data travels through {serverLabel(baseURL)}, the server
                    this browser is signed in to — a browser tab can’t hold a
                    workspace by itself.
                  </Aside>
                </Section>
              )}

              <Section>
                <SectionTitle>
                  {reachableNodeDid
                    ? '…or point this browser somewhere else'
                    : 'Point this browser at your data'}
                </SectionTitle>
                <Explainer>
                  {reachableNodeDid
                    ? 'Already synced your workspace somewhere else? Connect that server instead.'
                    : 'This browser isn’t signed in to a server that can reach your other devices. Connect one to bring your workspace here.'}
                </Explainer>
                <Button
                  subtle={!!reachableNodeDid}
                  onClick={() => setShowServerDialog(true)}
                >
                  Connect a server
                </Button>
              </Section>
            </>
          )}
        </Column>
      </OnboardingCard>

      <ConnectServerDialog
        knownServers={serverURLStorage.getKnownServers()}
        activeServer={baseURL}
        isNode={isNode}
        setServer={setServer}
        show={showServerDialog}
        bindShow={setShowServerDialog}
      />

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

/* The mechanism, for whoever wants it — a person who just wants their data
   back shouldn't have to read about servers to get it. */
const Aside = styled.p`
  margin: 0;
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
`;

const QrRow = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  min-width: 0;
`;
