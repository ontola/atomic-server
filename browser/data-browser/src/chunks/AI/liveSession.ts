// @wc-ignore-file
import { managedFetch } from '@helpers/managed/api';
import type { AtomicUIMessage } from './types';

export type LiveState = 'idle' | 'connecting' | 'live' | 'closing';
export interface LiveStatus {
  enabled: boolean;
  remaining_micros: number;
  credits_per_minute: number;
  minimum_credits: number;
}
export async function liveRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await managedFetch(`/ai/live${path}`, init);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      response.status === 401
        ? 'Sign in to your Atomic account to use voice credits.'
        : detail.slice(0, 500) || 'The live conversation request failed.',
    );
  }

  return response.json();
}

export function voiceHistory(messages: AtomicUIMessage[]) {
  let remaining = 40_000;

  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-60)
    .reverse()
    .flatMap(m => {
      const text = m.parts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n')
        .slice(-remaining);
      if (!text || remaining === 0) return [];
      remaining -= text.length;

      return [{ role: m.role, text }];
    })
    .reverse();
}

export class VoiceTranscript {
  private seen = new Set<string>();
  private last?: { message: AtomicUIMessage; end: number };
  readonly messages: AtomicUIMessage[] = [];

  append(event: Record<string, unknown>): AtomicUIMessage | undefined {
    const role =
      event.type === 'session.input_transcript.delta'
        ? 'user'
        : event.type === 'session.output_transcript.delta'
          ? 'assistant'
          : undefined;
    if (
      !role ||
      typeof event.delta !== 'string' ||
      !event.delta ||
      typeof event.start_ms !== 'number' ||
      typeof event.end_ms !== 'number'
    )
      return;

    if (typeof event.event_id === 'string') {
      if (this.seen.has(event.event_id)) return;
      this.seen.add(event.event_id);
    }

    if (
      !this.last ||
      this.last.message.role !== role ||
      event.start_ms - this.last.end > 1500
    ) {
      this.last = {
        message: {
          id: crypto.randomUUID(),
          role,
          metadata: { liveVoice: true },
          parts: [{ type: 'text', text: '' }],
        },
        end: event.end_ms,
      };
      this.messages.push(this.last.message);
    }

    const part = this.last.message.parts[0];
    if (part.type === 'text') part.text += event.delta;
    this.last.end = event.end_ms;

    return structuredClone(this.last.message);
  }
}

interface Options {
  history: AtomicUIMessage[];
  onState: (state: LiveState) => void;
  onTranscript: (message: AtomicUIMessage) => void;
  onUsage: (seconds: number) => void;
  onError: (message: string) => void;
  delegate: (
    messages: AtomicUIMessage[],
    signal: AbortSignal,
  ) => Promise<string>;
}

/** Owns media, lease renewal, and teardown independently of React renders. */
export class LiveSession {
  private peer?: RTCPeerConnection;
  private stream?: MediaStream;
  private audio?: HTMLAudioElement;
  private channel?: RTCDataChannel;
  private id?: string;
  private lease?: ReturnType<typeof setInterval>;
  private startupTimeout?: ReturnType<typeof setTimeout>;
  private closeTimeout?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private finished = false;
  private ready = false;
  private delegated = new Set<string>();
  private task?: AbortController;
  private transcript = new VoiceTranscript();

  constructor(private options: Options) {}

  async start() {
    this.options.onState('connecting');

    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        !globalThis.RTCPeerConnection
      )
        throw new Error(
          'Live conversations need microphone access in a secure browser.',
        );
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (this.stopped) {
        this.cleanup();

        return;
      }

      const peer = (this.peer = new RTCPeerConnection());
      const audio = (this.audio = new Audio());
      audio.autoplay = true;

      peer.ontrack = event => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio
          .play()
          .catch(() =>
            this.fail(
              'Your browser blocked voice playback. End the conversation and allow audio playback before retrying.',
            ),
          );
      };

      for (const track of this.stream.getTracks())
        peer.addTrack(track, this.stream);
      const channel = (this.channel = peer.createDataChannel('oai-events'));
      channel.onmessage = event => this.receive(event.data);

      channel.onclose = () => {
        if (!this.finished)
          this.fail(
            'The voice connection ended before final usage was confirmed. Reserved credits will be reconciled.',
          );
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' && !this.finished)
          this.fail('The voice connection was lost.');
      };

      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer);

      if (this.stopped) {
        this.cleanup();

        return;
      }

      // Do not abort this request on unmount: if it succeeds we must stop its ID.
      const created = await liveRequest<{
        id: string;
        sdp: string;
        deadline: number;
      }>('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: peer.localDescription?.sdp,
          messages: voiceHistory(this.options.history),
          accepted: true,
        }),
      });
      this.id = created.id;

      if (this.stopped) {
        await this.stop();

        return;
      }

      await peer.setRemoteDescription({ type: 'answer', sdp: created.sdp });
      this.lease = setInterval(() => void this.heartbeat(), 5000);
      this.startupTimeout = setTimeout(() => {
        if (!this.ready) this.fail('GPT-Live did not connect in time.');
      }, 20_000);
    } catch (error) {
      if (!this.stopped)
        this.options.onError(
          error instanceof Error
            ? error.message
            : 'Could not start the live conversation.',
        );
      await this.stop();
    }
  }

  private async heartbeat() {
    if (!this.id || this.stopped) return;

    try {
      const value = await liveRequest<{
        closing: boolean;
        finalized: boolean;
        deadline: number;
      }>(`/${this.id}/heartbeat`, { method: 'POST' });

      if (
        value.closing ||
        value.finalized ||
        Date.now() >= value.deadline * 1000
      ) {
        this.options.onError(
          'This live session has ended. You can start another conversation if you have credits remaining.',
        );
        await this.stop();
      }
    } catch {
      this.fail(
        'The credit connection was lost. The conversation is stopping.',
      );
    }
  }

  private receive(raw: string) {
    let event: Record<string, unknown>;

    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    if (this.finished) return;
    const message = this.transcript.append(event);
    if (message) this.options.onTranscript(message);

    if (event.type === 'session.started' && !this.stopped) {
      this.ready = true;
      clearTimeout(this.startupTimeout);
      this.options.onState('live');
    }

    if (
      event.type === 'session.usage.updated' ||
      event.type === 'session.closed'
    ) {
      const seconds = (event.usage as { seconds?: unknown } | undefined)
        ?.seconds;
      if (typeof seconds === 'number') this.options.onUsage(seconds);
    }

    if (event.type === 'session.closed') {
      this.finished = true;
      this.stopped = true;
      this.task?.abort();
      this.cleanup();
      this.options.onState('idle');
    } else if (event.type === 'error') {
      this.fail('GPT-Live reported a connection error. Please try again.');
    } else if (event.type === 'session.delegation.created' && !this.stopped) {
      const delegation = event.delegation as
        | { id?: string; target?: string }
        | undefined;

      if (
        delegation?.target === 'client' &&
        delegation.id &&
        !this.delegated.has(delegation.id)
      ) {
        this.delegated.add(delegation.id);
        void this.delegate(delegation.id);
      }
    }
  }

  private async delegate(id: string) {
    if (this.task) {
      this.say(
        id,
        'A previous task is still running. Wait for its result before starting another action.',
      );

      return;
    }

    const task = (this.task = new AbortController());

    try {
      const messages = [...this.options.history, ...this.transcript.messages];
      const text = await this.options.delegate(messages, task.signal);
      if (task.signal.aborted || this.stopped) return;
      const resultMessage: AtomicUIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        metadata: { liveVoice: true },
        parts: [{ type: 'text', text }],
      };
      this.transcript.messages.push(resultMessage);
      this.options.onTranscript(resultMessage);
      // Each append is limited to 500 tokens. A short result stays comfortably
      // within that bound for Latin text; the backend is asked for concise output.
      this.say(id, text.slice(0, 450));
    } catch (error) {
      if (!task.signal.aborted && !this.stopped) {
        this.say(
          id,
          'The task could not be completed. Do not claim success. Ask the user to check the chat.',
        );
        this.options.onError(
          error instanceof Error ? error.message : 'The voice task failed.',
        );
      }
    } finally {
      if (this.task === task) this.task = undefined;
    }
  }
  private say(id: string, content: string) {
    if (this.channel?.readyState === 'open' && !this.stopped)
      this.channel.send(
        JSON.stringify({
          type: 'session.commentary.append',
          delegation_id: id,
          content,
        }),
      );
  }
  mute(muted: boolean) {
    for (const track of this.stream?.getAudioTracks() ?? [])
      track.enabled = !muted;
  }
  private fail(message: string) {
    if (this.stopped) return;
    this.options.onError(message);
    void this.stop();
  }
  async stop() {
    this.stopped = true;
    this.task?.abort();
    clearInterval(this.lease);
    clearTimeout(this.startupTimeout);
    // Release the mic immediately; retain the event channel for final usage.
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.audio) this.audio.muted = true;
    if (!this.finished) this.options.onState('closing');
    if (this.channel?.readyState === 'open' && this.ready)
      this.channel.send(JSON.stringify({ type: 'session.close' }));

    if (this.id) {
      try {
        await liveRequest(`/${this.id}/stop`, {
          method: 'POST',
          keepalive: true,
        });
      } catch {
        this.options.onError(
          'Final credit usage is pending. The server will stop the session when its connection lease expires.',
        );
      }
    }

    if (this.finished) {
      this.cleanup();

      return;
    }

    if (!this.ready) {
      this.finished = true;
      this.cleanup();
      this.options.onState('idle');

      return;
    }

    clearTimeout(this.closeTimeout);
    this.closeTimeout = setTimeout(() => {
      this.finished = true;
      this.cleanup();
      this.options.onState('idle');
      this.options.onError('Final credit usage is still being reconciled.');
    }, 10_000);
  }
  private cleanup() {
    clearInterval(this.lease);
    clearTimeout(this.startupTimeout);
    clearTimeout(this.closeTimeout);
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.channel) this.channel.onclose = null;
    this.channel?.close();
    this.peer?.close();

    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
  }
}

function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', listener);
      reject(new Error('Could not establish the voice connection.'));
    }, 10_000);

    const listener = () => {
      if (peer.iceGatheringState !== 'complete') return;
      clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', listener);
      resolve();
    };

    peer.addEventListener('icegatheringstatechange', listener);
  });
}
