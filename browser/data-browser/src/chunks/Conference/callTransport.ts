// @wc-ignore-file
import { joinRoom } from 'trystero/nostr';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { hasManagedApi, managedFetch } from '../../helpers/managed/api';

/** Namespaces our rooms on the public signaling relays. */
const APP_ID = 'dev.atomicdata.conference';
const TOKEN_TIMEOUT_MS = 4000;

export interface PeerState {
  /** The peer's atomic agent subject, once known. */
  agent?: string;
  stream?: MediaStream;
}

export interface CallContext {
  /** Subject of the meeting resource; both transports derive the room from it. */
  subject: string;
  agentSubject?: string;
  /** Our own camera/mic, already acquired. */
  stream: MediaStream;
  setPeer: (id: string, patch: PeerState) => void;
  removePeer: (id: string) => void;
}

/** A transport joins the call and resolves to its leave function. */
type Transport = (ctx: CallContext) => Promise<() => void>;

const roomId = (subject: string) => bytesToHex(sha256(utf8ToBytes(subject)));

/**
 * Peer-to-peer WebRTC mesh (Trystero): peers find each other over public Nostr
 * relays, the meeting subject doubles as the signaling password. Media never
 * touches a server.
 */
export const joinMesh: Transport = async ctx => {
  const room = joinRoom(
    { appId: APP_ID, password: ctx.subject },
    roomId(ctx.subject),
  );
  const identity = room.makeAction<string>('identity');

  identity.onMessage = (agent, { peerId }) => ctx.setPeer(peerId, { agent });

  // Handlers are assigned before any peer can finish signaling, so every
  // participant comes through onPeerJoin exactly once.
  room.onPeerJoin = peerId => {
    ctx.setPeer(peerId, {});
    room.addStream(ctx.stream, { target: peerId });

    if (ctx.agentSubject) {
      identity.send(ctx.agentSubject, { target: peerId });
    }
  };

  room.onPeerLeave = ctx.removePeer;
  room.onPeerStream = (stream, peerId) => ctx.setPeer(peerId, { stream });

  return () => room.leave();
};

/** SFU via LiveKit; the managed saas hands out the token. Throws if unavailable. */
export const joinLivekit: Transport = async ctx => {
  const res = await managedFetch('/meetings/livekit-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: roomId(ctx.subject),
      name: (ctx.agentSubject ?? ctx.subject).slice(0, 128),
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`livekit-token: HTTP ${res.status}`);
  }

  const { url, token } = (await res.json()) as { url: string; token: string };
  const { Room, RoomEvent, Track } = await import('livekit-client');
  const room = new Room();

  // The participant name carries the agent subject, like the mesh introduction.
  const sync = (p: {
    identity: string;
    name?: string;
    trackPublications: Map<
      string,
      { track?: { mediaStreamTrack: MediaStreamTrack } }
    >;
  }) => {
    const tracks = [...p.trackPublications.values()]
      .map(pub => pub.track?.mediaStreamTrack)
      .filter((t): t is MediaStreamTrack => !!t);

    ctx.setPeer(p.identity, {
      agent: p.name?.startsWith('did:') ? p.name : undefined,
      stream: tracks.length ? new MediaStream(tracks) : undefined,
    });
  };

  room
    .on(RoomEvent.ParticipantConnected, sync)
    .on(RoomEvent.TrackSubscribed, (_t, _pub, p) => sync(p))
    .on(RoomEvent.TrackUnsubscribed, (_t, _pub, p) => sync(p))
    .on(RoomEvent.ParticipantDisconnected, p => ctx.removePeer(p.identity));

  await room.connect(url, token);
  room.remoteParticipants.forEach(sync);

  for (const track of ctx.stream.getTracks()) {
    await room.localParticipant.publishTrack(track, {
      source:
        track.kind === 'audio' ? Track.Source.Microphone : Track.Source.Camera,
    });
  }

  return () => {
    void room.disconnect();
  };
};

/**
 * Use the LiveKit SFU when the managed saas offers one; in every other case
 * (self-hosted, not configured, 503, timeout, connect failure) fall back to
 * the peer-to-peer mesh.
 */
export async function joinCall(
  ctx: CallContext,
  transports: { livekit: Transport; mesh: Transport } = {
    livekit: joinLivekit,
    mesh: joinMesh,
  },
  managed: () => boolean = hasManagedApi,
): Promise<() => void> {
  if (managed()) {
    try {
      return await transports.livekit(ctx);
    } catch (err) {
      console.warn('LiveKit unavailable, using peer-to-peer call:', err);
    }
  }

  return transports.mesh(ctx);
}
