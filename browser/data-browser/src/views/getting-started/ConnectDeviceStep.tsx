import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaMobileScreenButton } from 'react-icons/fa6';
import { useStore } from '@tomic/react';
import { Button } from '../../components/Button';
import { Column } from '../../components/Row';
import { ThisDeviceCode } from '../../components/ThisDeviceCode';
import { ConnectToDeviceForm } from '../../components/ConnectToDeviceForm';
import { ConnectServerDialog } from '../../components/ConnectServerDialog';
import { useOwnNodeDid } from '../../hooks/useOwnNodeDid';
import { usePairingFlow } from '../../components/pairing/PairingFlowProvider';
import { useSettings } from '../../helpers/AppSettings';
import { deviceHasDriveData } from '../../helpers/driveData';
import { fetchPersonalDriveSubject } from '../../helpers/personalDrive';
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
 * people their workspace wasn't there while it was landing. Poll instead.
 */
const DRIVE_WAIT_ATTEMPTS = 6;
const DRIVE_WAIT_STEP_MS = 500;

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
 * A plain browser tab has no node of its own to pair, so it gets the other
 * route to the same data: connect the server that has it.
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
   * The drive we should open once data lands. Re-resolved after the sync: on a
   * device that had nothing, the agent's personal drive may only become
   * knowable once the agent resource itself has been pulled across.
   *
   * `wait` gives the data a few seconds to show up (see DRIVE_WAIT_ATTEMPTS).
   */
  async function resolveArrivedDrive(
    wait: boolean,
  ): Promise<string | undefined> {
    const candidate =
      drive ??
      (agent
        ? await fetchPersonalDriveSubject(store, agent).catch(() => undefined)
        : undefined);

    if (!candidate) {
      return undefined;
    }

    const attempts = wait ? DRIVE_WAIT_ATTEMPTS : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      // The store cached a failed fetch of this drive a moment ago (that's how
      // we got here); ask the server again now that the sync has filled it in.
      if (await deviceHasDriveData(store, candidate, { refresh: true })) {
        return candidate;
      }

      if (attempt < attempts - 1) {
        await new Promise(resolve =>
          setTimeout(resolve, DRIVE_WAIT_STEP_MS * (attempt + 1)),
        );
      }
    }

    return undefined;
  }

  // Connecting a server is the browser's route out of here, and it can put the
  // drive back in reach. Notice that, rather than leaving the user on a screen
  // whose problem they just solved.
  useEffect(() => {
    if (isNode) {
      return;
    }

    let cancelled = false;

    void resolveArrivedDrive(false).then(arrived => {
      if (!cancelled && arrived) {
        onConnected(arrived);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [baseURL]);

  function connectWithCode(code: string) {
    // The dialog owns the progress and the outcome from here: connect, then
    // wait for the workspace to actually land, then offer to open it.
    startPairing(code, {
      drive,
      awaitWorkspace: () => resolveArrivedDrive(true),
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
                    <ThisDeviceCode nodeDid={nodeDid} />
                  </QrRow>
                </Section>
              )}
            </>
          ) : (
            <Section>
              <SectionTitle>Connect the server that has it</SectionTitle>
              <Explainer>
                This browser can’t sync directly with your other devices.
                Connect the server your workspace lives on to reach it.
              </Explainer>
              <Button onClick={() => setShowServerDialog(true)}>
                Connect a server
              </Button>
            </Section>
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

const QrRow = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  min-width: 0;
`;
