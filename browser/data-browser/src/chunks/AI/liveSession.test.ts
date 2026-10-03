import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managedFetch } from '@helpers/managed/api';
import { LiveSession, VoiceTranscript, voiceHistory } from './liveSession';
vi.mock('@helpers/managed/api', () => ({ managedFetch: vi.fn() }));

class Channel {
  readyState = 'open';
  onmessage?: (e: { data: string }) => void;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  event(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
class Peer extends EventTarget {
  static latest: Peer;
  channel = new Channel();
  iceGatheringState = 'complete';
  connectionState = 'connected';
  localDescription = { sdp: 'offer' };
  close = vi.fn();
  addTrack = vi.fn();
  createDataChannel() {
    return this.channel;
  }
  createOffer = async () => ({ type: 'offer', sdp: 'offer' });
  setLocalDescription = async () => {};
  setRemoteDescription = async () => {
    this.channel.event({ type: 'session.started' });
  };
  constructor() {
    super();
    Peer.latest = this;
  }
}
class AudioStub {
  autoplay = false;
  muted = false;
  srcObject = null;
  play = async () => {};
  pause = vi.fn();
}
const track = { stop: vi.fn(), enabled: true };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

function make() {
  const options = {
    history: [],
    onState: vi.fn(),
    onTranscript: vi.fn(),
    onUsage: vi.fn(),
    onError: vi.fn(),
    delegate: vi.fn().mockResolvedValue('Found your notes.'),
  };

  return { session: new LiveSession(options), options };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('Audio', AudioStub);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  vi.mocked(managedFetch).mockImplementation(async path =>
    Response.json(
      path === '/ai/live'
        ? { id: 'local-1', sdp: 'answer', deadline: Date.now() / 1000 + 60 }
        : {
            closing: false,
            finalized: false,
            deadline: Date.now() / 1000 + 60,
          },
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('live voice lifecycle', () => {
  it('does not request a microphone until started; closes mic immediately and waits for final usage', async () => {
    const { session, options } = make();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    await session.start();
    expect(options.onState).toHaveBeenLastCalledWith('live');
    Peer.latest.channel.event({
      type: 'session.usage.updated',
      usage: { seconds: 12 },
    });
    Peer.latest.channel.event({
      type: 'session.usage.updated',
      usage: { seconds: 15 },
    });
    expect(options.onUsage).toHaveBeenLastCalledWith(15);
    await session.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(managedFetch).toHaveBeenCalledWith(
      '/ai/live/local-1/stop',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(Peer.latest.close).not.toHaveBeenCalled();
    Peer.latest.channel.event({
      type: 'session.closed',
      usage: { seconds: 16 },
    });
    expect(Peer.latest.close).toHaveBeenCalled();
    expect(options.onState).toHaveBeenLastCalledWith('idle');
  });
  it('stops a session created after cancellation instead of leaving it billable', async () => {
    let resolve!: (r: Response) => void;
    const create = new Promise<Response>(r => {
      resolve = r;
    });
    vi.mocked(managedFetch).mockImplementation(path =>
      path === '/ai/live' ? create : Promise.resolve(Response.json({})),
    );
    const { session } = make();
    const starting = session.start();
    await vi.advanceTimersByTimeAsync(0);
    await session.stop();
    resolve(Response.json({ id: 'late', sdp: 'answer', deadline: 1 }));
    await starting;
    expect(managedFetch).toHaveBeenCalledWith(
      '/ai/live/late/stop',
      expect.anything(),
    );
    expect(Peer.latest.close).toHaveBeenCalled();
  });
  it('ends on credit lease failure, without trusting browser-reported usage for billing', async () => {
    const { session, options } = make();
    await session.start();
    vi.mocked(managedFetch).mockImplementation(async path => {
      if (path.endsWith('heartbeat')) throw new Error('offline');

      return Response.json({});
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(track.stop).toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledWith(
      expect.stringContaining('credit connection'),
    );
    const stop = vi
      .mocked(managedFetch)
      .mock.calls.find(([p]) => p.endsWith('/stop'));
    expect(stop?.[1]?.body).toBeUndefined();
  });
  it('deduplicates delegation and includes transcripts in the metered task', async () => {
    const { session, options } = make();
    await session.start();
    const channel = Peer.latest.channel;
    channel.event({
      type: 'session.input_transcript.delta',
      delta: 'Find my notes',
      start_ms: 0,
      end_ms: 500,
      event_id: 'one',
    });
    const delegation = {
      type: 'session.delegation.created',
      delegation: { id: 'task', target: 'client' },
    };
    channel.event(delegation);
    channel.event(delegation);
    await vi.advanceTimersByTimeAsync(0);
    expect(options.delegate).toHaveBeenCalledTimes(1);
    expect(options.delegate.mock.calls[0][0][0].parts[0].text).toBe(
      'Find my notes',
    );
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining('Found your notes.'),
    );
    expect(options.onTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: 'assistant' }),
    );
    await session.stop();
  });
});

describe('voice transcript and context', () => {
  it('preserves whitespace/repeated words and deduplicates only event IDs', () => {
    const transcript = new VoiceTranscript();
    const event = {
      type: 'session.input_transcript.delta',
      delta: 'yes ',
      start_ms: 0,
      end_ms: 10,
      event_id: 'a',
    };
    transcript.append(event);
    transcript.append(event);
    const message = transcript.append({
      ...event,
      event_id: 'b',
      start_ms: 10,
      end_ms: 20,
    });
    expect(message?.parts).toEqual([{ type: 'text', text: 'yes yes ' }]);
    transcript.append({
      ...event,
      event_id: 'c',
      start_ms: 4000,
      end_ms: 5000,
    });
    expect(transcript.messages).toHaveLength(2);
  });
  it('bounds history, removes tool payloads, and never sends a system role', () => {
    const history = voiceHistory([
      {
        id: 'system',
        role: 'system',
        parts: [{ type: 'text', text: 'secret' }],
      },
      {
        id: 'user',
        role: 'user',
        parts: [{ type: 'text', text: 'x'.repeat(50_000) }],
      },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0].text).toHaveLength(40_000);
  });
});
