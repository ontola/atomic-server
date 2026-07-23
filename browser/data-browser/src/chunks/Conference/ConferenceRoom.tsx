import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { useCurrentAgent, useResource, useTitle } from '@tomic/react';
import {
  FaMicrophone,
  FaMicrophoneSlash,
  FaPhone,
  FaVideo,
  FaVideoSlash,
} from 'react-icons/fa6';
import { joinRoom, type Room } from 'trystero/nostr';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Column, Row } from '../../components/Row';
import {
  IconButton,
  IconButtonVariant,
} from '../../components/IconButton/IconButton';
import { AgentAvatar } from '../../components/Presence/AgentAvatar';

/** Namespaces our rooms on the public signaling relays. */
const APP_ID = 'dev.atomicdata.conference';

interface PeerState {
  /** The peer's atomic agent subject, once they've introduced themselves. */
  agent?: string;
  stream?: MediaStream;
}

type MediaError = 'denied' | 'unavailable';

export interface ConferenceRoomProps {
  /** Subject of the meeting resource — every participant derives the same
   *  p2p room (and signaling password) from it. */
  subject: string;
  onLeave: () => void;
}

/**
 * In-meeting audio/video call. Fully peer-to-peer via WebRTC (Trystero):
 * peers find each other over public Nostr relays — the meeting subject is
 * hashed into the room id and doubles as the signaling password, so only
 * people who know the meeting can join or read the handshake. Media never
 * touches a server.
 */
export default function ConferenceRoom({
  subject,
  onLeave,
}: ConferenceRoomProps): React.JSX.Element {
  const [agent] = useCurrentAgent();
  const agentSubject = agent?.subject;

  const [localStream, setLocalStream] = useState<MediaStream>();
  const [peers, setPeers] = useState<Record<string, PeerState>>({});
  const [error, setError] = useState<MediaError>();
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [hasCamera, setHasCamera] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | undefined;
    let room: Room | undefined;

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

      room = joinRoom(
        { appId: APP_ID, password: subject },
        bytesToHex(sha256(utf8ToBytes(subject))),
      );

      const identity = room.makeAction<string>('identity');

      identity.onMessage = (peerAgent, { peerId }) => {
        setPeers(prev => ({
          ...prev,
          [peerId]: { ...prev[peerId], agent: peerAgent },
        }));
      };

      // Handlers are assigned before any peer can finish signaling, so
      // every participant — present or future — comes through onPeerJoin
      // exactly once; that's where we share our stream and identity.
      room.onPeerJoin = peerId => {
        setPeers(prev => ({ ...prev, [peerId]: prev[peerId] ?? {} }));

        if (stream) {
          room?.addStream(stream, { target: peerId });
        }

        if (agentSubject) {
          identity.send(agentSubject, { target: peerId });
        }
      };

      room.onPeerLeave = peerId => {
        setPeers(prev => {
          const next = { ...prev };
          delete next[peerId];

          return next;
        });
      };

      room.onPeerStream = (peerStream, peerId) => {
        setPeers(prev => ({
          ...prev,
          [peerId]: { ...prev[peerId], stream: peerStream },
        }));
      };
    }

    join();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach(track => track.stop());
      room?.leave();
      setLocalStream(undefined);
      setPeers({});
      setError(undefined);
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

  const peerEntries = Object.entries(peers);

  return (
    <CallSection>
      {error ? (
        <ErrorMessage>
          {error === 'denied'
            ? 'Microphone access was denied — allow it in your browser to join the call.'
            : 'No microphone or camera found.'}
        </ErrorMessage>
      ) : (
        <TileGrid>
          <Tile>
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
            <PeerTile key={peerId} peer={peer} />
          ))}
        </TileGrid>
      )}
      {!error && peerEntries.length === 0 && (
        <WaitingNote>Waiting for others to join…</WaitingNote>
      )}
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
    </CallSection>
  );
}

/** One remote participant: their live video (which also carries their
 *  audio), with an avatar + name badge once they've introduced themselves. */
function PeerTile({ peer }: { peer: PeerState }) {
  const agentResource = useResource(peer.agent);
  const [name] = useTitle(agentResource);

  return (
    <Tile>
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

const CallSection = styled(Column)`
  gap: ${p => p.theme.size(2)};
  padding-bottom: ${p => p.theme.size(2)};
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  margin-bottom: ${p => p.theme.size(2)};
`;

const TileGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: ${p => p.theme.size(2)};
  max-height: 40vh;
  overflow-y: auto;
`;

const Tile = styled.div`
  position: relative;
  aspect-ratio: 4 / 3;
  border-radius: ${p => p.theme.radius};
  overflow: hidden;
  background-color: ${p => p.theme.colors.bg1};
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
