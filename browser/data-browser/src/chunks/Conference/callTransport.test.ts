// @wc-ignore-file
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  managedFetch: vi.fn(),
  connect: vi.fn(),
  publishTrack: vi.fn(),
  disconnect: vi.fn(),
  leave: vi.fn(),
}));

vi.mock('../../helpers/managed/api', () => ({
  managedFetch: mocks.managedFetch,
  hasManagedApi: () => true,
}));
vi.mock('livekit-client', () => ({
  Room: class {
    remoteParticipants = new Map();
    localParticipant = { publishTrack: mocks.publishTrack };
    connect = mocks.connect;
    disconnect = mocks.disconnect;
    on() {
      return this;
    }
  },
  RoomEvent: {},
  Track: { Source: { Microphone: 'mic', Camera: 'cam' } },
}));
vi.mock('trystero/nostr', () => ({
  joinRoom: () => ({
    makeAction: () => ({}),
    leave: mocks.leave,
  }),
}));

import {
  joinCall,
  joinLivekit,
  joinMesh,
  type CallContext,
} from './callTransport';

const track = (kind: string) => ({ kind }) as MediaStreamTrack;
const ctx = (): CallContext => ({
  subject: 'did:ad:meeting',
  agentSubject: 'did:ad:agent:abc',
  stream: { getTracks: () => [track('audio'), track('video')] } as MediaStream,
  setPeer: vi.fn(),
  removePeer: vi.fn(),
});

const run = (c = ctx()) =>
  joinCall(c, { livekit: joinLivekit, mesh: joinMesh });

afterEach(() => vi.clearAllMocks());

describe('joinCall transport selection', () => {
  it('uses LiveKit when the token endpoint answers', async () => {
    mocks.managedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ url: 'wss://lk', token: 't', identity: 'i' }),
      ),
    );
    const leave = await run();

    expect(mocks.connect).toHaveBeenCalledWith('wss://lk', 't');
    expect(mocks.publishTrack).toHaveBeenCalledTimes(2);
    const body = JSON.parse(mocks.managedFetch.mock.calls[0][1].body);
    expect(body.name).toBe('did:ad:agent:abc');
    expect(body.room).toMatch(/^[0-9a-f]{64}$/);

    leave();
    expect(mocks.disconnect).toHaveBeenCalled();
    expect(mocks.leave).not.toHaveBeenCalled();
  });

  it('falls back to the mesh on 503', async () => {
    mocks.managedFetch.mockResolvedValue(new Response('', { status: 503 }));
    const leave = await run();

    expect(mocks.connect).not.toHaveBeenCalled();
    leave();
    expect(mocks.leave).toHaveBeenCalled();
  });

  it('falls back to the mesh on a network error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.managedFetch.mockRejectedValue(new TypeError('network'));
    const leave = await run();

    expect(warn).toHaveBeenCalled();
    leave();
    expect(mocks.leave).toHaveBeenCalled();
  });

  it('falls back to the mesh when connecting fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.managedFetch.mockResolvedValue(
      new Response(JSON.stringify({ url: 'wss://lk', token: 't' })),
    );
    mocks.connect.mockRejectedValueOnce(new Error('boom'));
    const leave = await run();

    leave();
    expect(mocks.leave).toHaveBeenCalled();
  });

  it('skips the token call without a managed api', async () => {
    const leave = await joinCall(
      ctx(),
      { livekit: joinLivekit, mesh: joinMesh },
      () => false,
    );

    expect(mocks.managedFetch).not.toHaveBeenCalled();
    leave();
    expect(mocks.leave).toHaveBeenCalled();
  });
});
