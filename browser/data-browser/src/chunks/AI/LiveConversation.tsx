import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, offset, shift } from '@floating-ui/dom';
import toast from 'react-hot-toast';
import { FaMicrophone } from 'react-icons/fa6';
import { IconButton } from '@components/IconButton/IconButton';
import { hasManagedApi, managedFetch } from '@helpers/managed/api';
import { onManagedLogout } from '@helpers/managed/session';
import { recordingWav, voiceRequest } from './voiceTurn';
import { styled } from 'styled-components';
import { observeVolume, observeWords } from './voiceFeedback';
import type { AIMessageContext, AtomicUIMessage } from './types';

type State =
  | 'idle'
  | 'microphone'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'speaking';
interface Props {
  apiKey?: string;
  transcriptionModel: string;
  onConfigure: () => void;
  messages: AtomicUIMessage[];
  busy: boolean;
  delegate: (
    messages: AtomicUIMessage[],
    signal: AbortSignal,
  ) => Promise<string>;
  onTranscript: (message: AtomicUIMessage) => void;
  /** Hands over the resources attached in the composer, like a typed send. */
  takeContext: () => AIMessageContext[];
  onActive: (active: boolean) => void;
}

export function LiveConversation(props: Props) {
  const [state, setState] = useState<State>('idle');
  const [status, setStatus] = useState<{
    enabled: boolean;
    remaining_micros: number;
  }>();
  const [error, setError] = useState('');
  const [volume, setVolume] = useState(0);
  const [words, setWords] = useState('');
  const micRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const mic = micRef.current;
    const preview = previewRef.current;
    if (!mic || !preview) return;

    return autoUpdate(mic, preview, () => {
      void computePosition(mic, preview, {
        placement: 'top-end',
        strategy: 'fixed',
        middleware: [offset(12), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        preview.style.left = `${x}px`;
        preview.style.top = `${y}px`;
      });
    });
  }, [state, words]);
  const feedback = useRef<(() => void) | undefined>(undefined);
  const callbacks = useRef(props);
  const active = useRef<AbortController | undefined>(undefined);
  const media = useRef<MediaStream | undefined>(undefined);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  const url = useRef<string | undefined>(undefined);
  useEffect(() => {
    callbacks.current = props;
  }, [props]);

  const transition = (next: State) => {
    setState(next);
    callbacks.current.onActive(next !== 'idle');
  };

  const release = () => {
    clearTimeout(timer.current);
    feedback.current?.();
    feedback.current = undefined;
    media.current?.getTracks().forEach(t => t.stop());
    media.current = undefined;
  };

  const cancel = () => {
    active.current?.abort();
    active.current = undefined;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release();
    audio.current?.pause();
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = undefined;
    transition('idle');
  };

  useEffect(() => {
    if (props.apiKey || !hasManagedApi()) return;
    let alive = true;
    managedFetch('/ai/voice/status')
      .then(async r => {
        if (!r.ok) throw new Error();

        return r.json();
      })
      .then(v => {
        if (alive) setStatus(v);
      })
      .catch(() => {
        if (alive) setError('Sign in to your Atomic account to use voice.');
      });

    return () => {
      alive = false;
    };
  }, [state, props.apiKey]);
  useEffect(() => onManagedLogout(cancel), []);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = undefined;
      release();
      if (recorder.current?.state === 'recording') recorder.current.stop();
      audio.current?.pause();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  const speak = async (text: string, task: AbortController) => {
    transition('speaking');
    const response = await voiceRequest(
      'speak',
      text.slice(0, 1600),
      task.signal,
      callbacks.current.apiKey,
    );
    const blob = await response.blob();
    if (task.signal.aborted) return;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = URL.createObjectURL(blob);
    const player = new Audio(url.current);
    audio.current = player;
    await new Promise<void>((resolve, reject) => {
      player.onended = () => resolve();
      player.onerror = () =>
        reject(
          new Error('Audio playback failed. Your reply is saved in chat.'),
        );
      task.signal.addEventListener(
        'abort',
        () => {
          player.pause();
          resolve();
        },
        { once: true },
      );
      void player.play().catch(reject);
    });
  };

  const finish = async (blob: Blob, task: AbortController) => {
    if (task.signal.aborted) return;
    release();

    try {
      transition('transcribing');
      const wav = await recordingWav(blob);
      if (task.signal.aborted) return;
      const response = await voiceRequest(
        'transcribe',
        wav,
        task.signal,
        callbacks.current.apiKey,
        callbacks.current.transcriptionModel,
      );
      const { text } = await response.json();
      if (task.signal.aborted) return;
      if (typeof text !== 'string' || !text.trim())
        throw new Error('No speech detected. Please try again.');
      const userContext = callbacks.current.takeContext();
      const message: AtomicUIMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        metadata: {
          liveVoice: true,
          ...(userContext.length > 0 && { userContext }),
        },
        parts: [{ type: 'text', text }],
      };
      const history = [...callbacks.current.messages, message];
      callbacks.current.onTranscript(message);
      transition('thinking');
      const result = await callbacks.current.delegate(history, task.signal);
      if (task.signal.aborted) return;
      callbacks.current.onTranscript({
        id: crypto.randomUUID(),
        role: 'assistant',
        metadata: { liveVoice: true },
        parts: [{ type: 'text', text: result }],
      });
      await speak(result, task);
    } catch (e) {
      if (!task.signal.aborted)
        setError(e instanceof Error ? e.message : 'Voice request failed.');
    } finally {
      if (active.current === task) {
        active.current = undefined;
        transition('idle');
      }
    }
  };

  const start = async () => {
    if (active.current) return;

    if (props.busy) {
      toast('Wait for the current reply to finish.');

      return;
    }

    setError('');
    setWords('');
    setVolume(0);
    const task = new AbortController();
    active.current = task;
    transition('microphone');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      if (task.signal.aborted) {
        stream.getTracks().forEach(t => t.stop());

        return;
      }

      media.current = stream;
      const recording = new MediaRecorder(stream);
      recorder.current = recording;
      const chunks: Blob[] = [];

      recording.ondataavailable = e => {
        if (e.data.size) chunks.push(e.data);
      };

      recording.onstop = () => {
        void finish(new Blob(chunks, { type: recording.mimeType }), task);
      };

      recording.onerror = () => {
        setError('Microphone recording failed.');
        cancel();
      };

      recording.start();
      transition('recording');
      // Feedback is optional; unsupported audio analysis must not block capture.
      let stopVolume = () => {};

      try {
        stopVolume = observeVolume(stream, setVolume);
      } catch {}

      const stopWords = observeWords(setWords);

      feedback.current = () => {
        stopVolume();
        stopWords();
      };

      timer.current = setTimeout(() => {
        if (recording.state === 'recording') recording.stop();
      }, 60000);
    } catch (e) {
      if (!task.signal.aborted) {
        setError(e instanceof Error ? e.message : 'Microphone unavailable.');
        cancel();
      }
    }
  };

  const label =
    state === 'recording'
      ? 'Send recording'
      : state === 'idle'
        ? 'Start voice message'
        : 'Stop voice message';
  const hint =
    state === 'idle'
      ? error ||
        (props.apiKey
          ? 'Start voice message · uses your OpenRouter key'
          : !status?.enabled
            ? 'Voice is unavailable: configure OpenRouter on the Atomic service.'
            : status.remaining_micros < 1000
              ? 'Not enough credits.'
              : 'Start voice message · uses Atomic credits')
      : state === 'recording'
        ? 'Send recording · Esc to cancel'
        : state === 'speaking'
          ? 'Stop speaking'
          : 'Processing · click to cancel';

  return (
    <VoiceControl>
      {state === 'recording' &&
        words &&
        micRef.current &&
        createPortal(
          <WordPreview
            ref={previewRef}
            role='status'
            aria-label='Speech preview'
          >
            {words}
          </WordPreview>,
          micRef.current.ownerDocument.body,
        )}
      <MicButton
        ref={micRef}
        $level={state === 'recording' ? volume : 0}
        title={hint}
        aria-label={label}
        aria-pressed={state === 'recording'}
        style={{
          color:
            state === 'recording'
              ? `hsl(${355 + volume * 15} 80% ${42 + volume * 12}%)`
              : undefined,
          opacity: state !== 'idle' && state !== 'recording' ? 0.5 : 1,
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
        onClick={() => {
          if (state === 'idle') {
            if (
              !props.apiKey &&
              (!status?.enabled || status.remaining_micros < 1000)
            ) {
              props.onConfigure();

              return;
            }

            void start();
          } else if (state === 'recording') recorder.current?.stop();
          else cancel();
        }}
      >
        <FaMicrophone />
      </MicButton>
    </VoiceControl>
  );
}

const VoiceControl = styled.span`
  position: relative;
  display: inline-flex;
`;
const MicButton = styled(IconButton)<{ $level: number }>`
  && {
    transition:
      color 75ms linear,
      box-shadow 75ms linear;
  }
  box-shadow: 0 0 0 ${p => p.$level * 7}px
    rgb(220 45 70 / ${p => p.$level * 0.18});
  svg {
    transform: scale(${p => 1 + p.$level * 0.38});
    transition: transform 75ms ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    svg {
      transform: none;
    }
  }
`;
const WordPreview = styled.span`
  position: fixed;
  z-index: 1000;
  width: max-content;
  max-width: min(22rem, 70vw);
  max-height: 6rem;
  overflow: auto;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  background: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  box-shadow: 0 2px 12px rgb(0 0 0 / 15%);
  font-size: 0.9rem;
  pointer-events: none;
`;
