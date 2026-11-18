import type { BrowserContext, WebSocketRoute } from '@playwright/test';
import { expect } from './fixtures';

export const SIGNALING = 'wss://resource-peers.test/webrtc-signal';

/** Rendezvous only: SDP goes through this relay, while authenticated resource
 * data and receipts cross real browser WebRTC channels and the real WASM DB. */
export function signalingRoom() {
  const rooms = new Map<string, Map<string, WebSocketRoute>>();
  let disposed = false;

  async function install(context: BrowserContext) {
    await context.routeWebSocket(SIGNALING, socket => {
      let room: Map<string, WebSocketRoute> | undefined;
      let peer: string | undefined;
      socket.onMessage(raw => {
        if (disposed) return;
        const message = JSON.parse(String(raw));

        if (message.type === 'join') {
          expect(message.peer).toMatch(/^[a-f0-9]{64}$/);
          expect(message.room).toMatch(/^[a-f0-9]{64}$/);
          peer = message.peer;
          room = rooms.get(message.room) ?? new Map();
          rooms.set(message.room, room);
          const peers = [...room.keys()];
          room.set(peer!, socket);
          socket.send(
            JSON.stringify({ type: 'joined', peers, iceServers: [] }),
          );
          for (const id of peers)
            room.get(id)!.send(JSON.stringify({ type: 'peer', peer }));
        } else {
          expect(['offer', 'answer']).toContain(message.type);
          expect(peer).toBeTruthy();
          room?.get(message.to)?.send(
            JSON.stringify({
              type: message.type,
              from: peer,
              sdp: message.sdp,
            }),
          );
        }
      });
      socket.onClose(() => {
        if (disposed || !peer || room?.get(peer) !== socket) return;
        room.delete(peer);
        for (const destination of room.values())
          destination.send(JSON.stringify({ type: 'left', peer }));
      });
    });
  }

  return {
    install,
    roomId: () => [...rooms.keys()][0],
    dispose: () => {
      disposed = true;
      for (const room of rooms.values()) room.clear();
      rooms.clear();
    },
    memberCount: () =>
      Math.max(0, ...[...rooms.values()].map(room => room.size)),
  };
}
