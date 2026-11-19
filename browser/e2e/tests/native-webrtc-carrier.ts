import path from 'node:path';
import type { Page } from '@playwright/test';
import { buildNativeCarrier } from '../scripts/native-webrtc-carrier-bundle.mjs';
import { SIGNALING } from './resource-peer-test-utils';
import type { nativeHost } from './native-host-test-utils';

interface CarrierPipe {
  send(frame: Uint8Array): Promise<void>;
  recv(): Promise<Uint8Array | null>;
}
interface CarrierPeer {
  transport: Promise<CarrierPipe>;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void>;
  channelBinding(): Promise<string>;
  close(): void;
}

declare global {
  interface Window {
    NativeCarrierTransport: { WebRtcPeer: new () => CarrierPeer };
    nativeCarrier: {
      errors: string[];
      held: number[][];
      release(): Promise<void>;
      hold(): void;
      close(): Promise<void>;
    };
    nativeCarrierCall(method: string, args?: unknown[]): Promise<unknown>;
  }
}

/** Real ordered SCTP/DTLS transport, with all native protocol/storage work in
 * WebRtcPeerLink. This carrier replaces Flutter's byte-moving plugin only. */
export async function startNativeCarrier(
  page: Page,
  host: Awaited<ReturnType<typeof nativeHost>>,
  args: { url: string; room: string; drive: string; agent: string },
) {
  const code = await buildNativeCarrier(
    path.resolve(__dirname, '../../lib/src/webrtc-peer.ts'),
  );
  await page.exposeBinding('nativeCarrierCall', (_source, method, params) =>
    host.call(method, params),
  );
  await page.goto(`${args.url}/test-carrier.html`);
  await page.addScriptTag({ content: code });
  await page.evaluate(
    ({ room, drive, agent, signaling }) => {
      const peer = new window.NativeCarrierTransport.WebRtcPeer();
      const socket = new WebSocket(signaling);
      const peerId = '0'.repeat(64);
      let stopped = false;
      let holding = true;
      let started = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let pipe: CarrierPipe;
      const held: number[][] = [];
      const errors: string[] = [];
      const call = window.nativeCarrierCall;

      const fail = (error: unknown) => {
        if (!stopped) errors.push(String(error));
      };

      const send = async (frames: number[][]) => {
        for (const frame of frames) {
          if (holding && frame[0] === 0x35) held.push(frame);
          else await pipe.send(Uint8Array.from(frame));
        }
      };

      const begin = async () => {
        pipe = await peer.transport;
        const binding = await peer.channelBinding();
        const challenge = (await call('__test_link_open', [
          drive,
          binding,
          agent,
        ])) as number[];
        await send([challenge]);

        const live = async () => {
          while (!stopped)
            await send((await call('__test_link_live')) as number[][]);
        };

        while (!stopped) {
          const frame = await pipe.recv();
          if (!frame) break;
          const output = (await call('__test_link_handle', [
            Array.from(frame),
          ])) as { frames: number[][]; ready: boolean };
          await send(output.frames);

          if (output.ready && !started) {
            started = true;

            const reconcile = async () => {
              const reconcileFrame = (await call('__test_link_reconcile')) as
                | number[]
                | null;
              if (reconcileFrame) await send([reconcileFrame]);
            };

            await reconcile();
            timer = setInterval(() => void reconcile().catch(fail), 2000);
            void live().catch(fail);
          }
        }

        if (!stopped) await window.nativeCarrier.close();
      };

      socket.onopen = () =>
        socket.send(JSON.stringify({ type: 'join', room, peer: peerId }));

      socket.onmessage = event => {
        const message = JSON.parse(event.data);

        if (message.type === 'joined') {
          const destination = message.peers[0];
          if (!destination)
            return fail(new Error('Expected browser in signaling room'));
          void peer
            .createOffer()
            .then(offer => {
              socket.send(
                JSON.stringify({
                  type: 'offer',
                  to: destination,
                  sdp: offer.sdp,
                }),
              );
              void begin().catch(fail);
            })
            .catch(fail);
        } else if (message.type === 'answer') {
          void peer
            .acceptAnswer({ type: 'answer', sdp: message.sdp })
            .catch(fail);
        }
      };

      window.nativeCarrier = {
        errors,
        held,
        hold: () => {
          holding = true;
        },
        release: async () => {
          holding = false;
          await send(held.splice(0));
        },
        close: async () => {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          peer.close();
          socket.close();
          await call('__test_link_close');
        },
      };
    },
    { ...args, signaling: SIGNALING },
  );
}
