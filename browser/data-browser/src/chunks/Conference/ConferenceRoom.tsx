import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { dataBrowser } from '@tomic/lib';
import { useCurrentAgent, useResource, useTitle } from '@tomic/react';
import {
  FaCircle,
  FaMicrophone,
  FaMicrophoneSlash,
  FaPhone,
  FaStop,
  FaVideo,
  FaVideoSlash,
} from 'react-icons/fa6';
import { Column, Row } from '../../components/Row';
import {
  IconButton,
  IconButtonVariant,
} from '../../components/IconButton/IconButton';
import { AgentAvatar } from '../../components/Presence/AgentAvatar';
import { joinCall, type PeerState } from './callTransport';
import {
  startRecording,
  stopRecording,
  withRecording,
  type RunningRecording,
} from './callRecording';

type MediaError = 'denied' | 'unavailable';

export interface ConferenceRoomProps {
  /** Subject of the meeting resource — every participant derives the same
   *  p2p room (and signaling password) from it. */
  subject: string;
  onLeave: () => void;
  /** A small tile (the app's floating call): the others first, no controls.
   *  The person expands the tile to get the controls. */
  compact?: boolean;
}

/**
 * In-meeting audio/video call. Transport (LiveKit SFU or peer-to-peer mesh)
 * is chosen in `callTransport.ts`; this component only renders tiles and
 * controls.
 */
export default function ConferenceRoom({
  subject,
  onLeave,
  compact = false,
}: ConferenceRoomProps): React.JSX.Element {
  const [agent] = useCurrentAgent();
  const agentSubject = agent?.subject;

  const [localStream, setLocalStream] = useState<MediaStream>();
  const [peers, setPeers] = useState<Record<string, PeerState>>({});
  const [error, setError] = useState<MediaError>();
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [hasCamera, setHasCamera] = useState(true);
  const [transport, setTransport] = useState<'livekit' | 'mesh'>();
  /** The room is being recorded, by anyone. */
  const [recorded, setRecorded] = useState(false);
  /** The recording this person started, to stop it. */
  const [running, setRunning] = useState<RunningRecording>();
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordError, setRecordError] = useState(false);
  const meeting = useResource(subject);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | undefined;
    let leaveCall: (() => void) | undefined;

    async function join() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
        });
      } catch {
        // No (or blocked) camera — a mic-only call still works.
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
          if (!cancelled) {
            setError(
              (err as DOMException)?.name === /* @wc-ignore */ 'NotAllowedError'
                ? 'denied'
                : 'unavailable',
            );
          }

          return;
        }
      }

      if (cancelled) {
        stream.getTracks().forEach(track => track.stop());

        return;
      }

      setLocalStream(stream);
      setHasCamera(stream.getVideoTracks().length > 0);

      const leave = await joinCall({
        subject,
        agentSubject,
        stream,
        setPeer: (id, patch) =>
          setPeers(prev => ({ ...prev, [id]: { ...prev[id], ...patch } })),
        removePeer: id =>
          setPeers(prev => {
            const next = { ...prev };
            delete next[id];

            return next;
          }),
        onTransport: setTransport,
        onRecording: setRecorded,
      });

      if (cancelled) {
        leave();
      } else {
        leaveCall = leave;
      }
    }

    join();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach(track => track.stop());
      leaveCall?.();
      setLocalStream(undefined);
      setPeers({});
      setError(undefined);
      setTransport(undefined);
      setRecorded(false);
    };
  }, [subject, agentSubject]);

  const toggleMic = () => {
    localStream?.getAudioTracks().forEach(track => {
      track.enabled = !micOn;
    });
    setMicOn(!micOn);
  };

  const toggleCam = () => {
    localStream?.getVideoTracks().forEach(track => {
      track.enabled = !camOn;
    });
    setCamOn(!camOn);
  };

  /** Keeps [recording] on the Meeting, so everyone who reads it can watch. */
  const keep = async (recording: RunningRecording['recording']) => {
    await meeting.set(
      dataBrowser.properties.meetingRecordings,
      withRecording(
        meeting.get(dataBrowser.properties.meetingRecordings),
        recording,
      ),
    );
    await meeting.save();
  };

  const toggleRecording = async () => {
    setRecordBusy(true);
    setRecordError(false);

    try {
      if (running) {
        await stopRecording(running.egressId);
        await keep({ ...running.recording, endedAt: Date.now() });
        setRunning(undefined);
      } else {
        const started = await startRecording(subject);
        setRunning(started);
        // Kept right away: the file exists even if this tab closes.
        await keep(started.recording);
      }
    } catch (err) {
      console.warn('Recording failed:', err);
      setRecordError(true);
    } finally {
      setRecordBusy(false);
    }
  };

  const peerEntries = Object.entries(peers);

  return (
    <CallSection $compact={compact}>
      {recorded && (
        <RecordingBadge $compact={compact} role='status'>
          <FaCircle /> Recording
        </RecordingBadge>
      )}
      {error ? (
        <ErrorMessage>
          {error === 'denied'
            ? 'Microphone access was denied — allow it in your browser to join the call.'
            : 'No microphone or camera found.'}
        </ErrorMessage>
      ) : (
        <TileGrid $compact={compact}>
          <Tile $last={compact} $compact={compact}>
            <PeerVideo
              $mirrored
              muted
              autoPlay
              playsInline
              ref={element => {
                if (
                  element &&
                  localStream &&
                  element.srcObject !== localStream
                ) {
                  element.srcObject = localStream;
                }
              }}
            />
            <TileBadge>
              {agentSubject && (
                <AgentAvatar agentSubject={agentSubject} size='1.2rem' />
              )}
              <span>You</span>
            </TileBadge>
          </Tile>
          {peerEntries.map(([peerId, peer]) => (
            <PeerTile key={peerId} peer={peer} compact={compact} />
          ))}
        </TileGrid>
      )}
      {recordError && !compact && (
        <ErrorMessage>
          The recording could not be started or stopped.
        </ErrorMessage>
      )}
      {!error && peerEntries.length === 0 && !compact && (
        <WaitingNote>Waiting for others to join…</WaitingNote>
      )}
      {!compact && (
        <Row center justify='center' gap='0.5rem'>
          <IconButton
            variant={IconButtonVariant.Square}
            title={micOn ? 'Mute microphone' : 'Unmute microphone'}
            size='1.1rem'
            disabled={!localStream}
            onClick={toggleMic}
          >
            {micOn ? <FaMicrophone /> : <FaMicrophoneSlash />}
          </IconButton>
          <IconButton
            variant={IconButtonVariant.Square}
            title={camOn ? 'Turn camera off' : 'Turn camera on'}
            size='1.1rem'
            disabled={!localStream || !hasCamera}
            onClick={toggleCam}
          >
            {camOn && hasCamera ? <FaVideo /> : <FaVideoSlash />}
          </IconButton>
          {transport === 'livekit' && (!recorded || running) && (
            <IconButton
              variant={IconButtonVariant.Square}
              title={running ? 'Stop recording' : 'Record this call'}
              size='1.1rem'
              disabled={recordBusy}
              onClick={toggleRecording}
            >
              {running ? <FaStop /> : <FaCircle />}
            </IconButton>
          )}
          <IconButton
            variant={IconButtonVariant.Colored}
            color='alert'
            title='Leave call'
            size='1.1rem'
            onClick={onLeave}
          >
            <HangUpIcon />
          </IconButton>
        </Row>
      )}
    </CallSection>
  );
}

/** One remote participant: their live video (which also carries their
 *  audio), with an avatar + name badge once they've introduced themselves. */
function PeerTile({ peer, compact }: { peer: PeerState; compact?: boolean }) {
  const agentResource = useResource(peer.agent);
  const [name] = useTitle(agentResource);

  return (
    <Tile $compact={compact}>
      {peer.stream ? (
        <PeerVideo
          autoPlay
          playsInline
          ref={element => {
            if (element && peer.stream && element.srcObject !== peer.stream) {
              element.srcObject = peer.stream;
            }
          }}
        />
      ) : (
        <ConnectingNote>Connecting…</ConnectingNote>
      )}
      <TileBadge>
        {peer.agent && <AgentAvatar agentSubject={peer.agent} size='1.2rem' />}
        <span>{peer.agent ? name : '…'}</span>
      </TileBadge>
    </Tile>
  );
}

const RecordingBadge = styled.div<{ $compact?: boolean }>`
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 0.4em;
  padding: 0.2em 0.6em;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.alert};
  color: white;
  font-size: 0.85rem;
  font-weight: 600;

  svg {
    font-size: 0.6em;
  }

  ${p =>
    p.$compact &&
    `
    position: absolute;
    top: 0.4rem;
    left: 0.4rem;
    z-index: 1;
  `}
`;

const CallSection = styled(Column)<{ $compact?: boolean }>`
  gap: ${p => p.theme.size(2)};
  padding-bottom: ${p => p.theme.size(2)};
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  margin-bottom: ${p => p.theme.size(2)};

  /* A small tile of an app: the video is the whole tile. */
  ${p =>
    p.$compact &&
    `
    position: relative;
    height: 100%;
    gap: 0;
    padding: 0;
    border: none;
    margin: 0;
  `}
`;

const TileGrid = styled.div<{ $compact?: boolean }>`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: ${p => p.theme.size(2)};
  max-height: 40vh;
  overflow-y: auto;

  ${p =>
    p.$compact &&
    `
    grid-template-columns: 1fr;
    grid-auto-rows: 100%;
    gap: 0;
    height: 100%;
    max-height: none;
    overflow: hidden;
  `}
`;

const Tile = styled.div<{ $last?: boolean; $compact?: boolean }>`
  ${p => p.$last && 'order: 1;'}
  position: relative;
  aspect-ratio: 4 / 3;
  border-radius: ${p => p.theme.radius};
  overflow: hidden;
  background-color: ${p => p.theme.colors.bg1};

  ${p =>
    p.$compact &&
    `
    aspect-ratio: auto;
    height: 100%;
    border-radius: 0;
    background-color: #000;
  `}
`;

const PeerVideo = styled.video<{ $mirrored?: boolean }>`
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  ${p => p.$mirrored && 'transform: scaleX(-1);'}
`;

const TileBadge = styled.span`
  position: absolute;
  left: 0.4rem;
  bottom: 0.4rem;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  max-width: calc(100% - 0.8rem);
  padding: 0.1rem 0.45rem;
  border-radius: 1rem;
  font-size: 0.75rem;
  color: white;
  background-color: rgba(0, 0, 0, 0.55);

  & > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const ConnectingNote = styled.span`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const WaitingNote = styled.span`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
  text-align: center;
`;

const ErrorMessage = styled.span`
  font-size: 0.85rem;
  color: ${p => p.theme.colors.alert};
  text-align: center;
`;

/** FaPhone rotated into the universal "hang up" glyph. */
const HangUpIcon = styled(FaPhone)`
  transform: rotate(135deg);
`;
