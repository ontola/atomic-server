// @wc-ignore-file
import { managedFetch } from '@helpers/managed/api';

export async function voiceRequest(
  kind: 'transcribe' | 'speak',
  data: string,
  signal: AbortSignal,
  apiKey?: string,
  transcriptionModel = 'openai/whisper-1',
) {
  const response = apiKey
    ? await fetch(
        `https://openrouter.ai/api/v1/audio/${kind === 'transcribe' ? 'transcriptions' : 'speech'}`,
        {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(
            kind === 'transcribe'
              ? {
                  model: transcriptionModel,
                  input_audio: { data, format: 'wav' },
                }
              : {
                  model: 'microsoft/mai-voice-2',
                  input: data,
                  voice: 'en-US-Harper:MAI-Voice-2',
                  response_format: 'mp3',
                },
          ),
        },
      )
    : await managedFetch('/ai/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ kind, data, accepted: true }),
      });
  if (!response.ok)
    throw new Error(
      response.status === 401 && !apiKey
        ? 'Sign in to your Atomic account to use voice.'
        : (await response.text()).slice(0, 300),
    );

  return response;
}

/** Fixed PCM format lets SaaS verify duration before reserving credits. */
export function pcmWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);

  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      bytes[offset + i] = value.charCodeAt(i);
  };

  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) =>
    view.setInt16(
      44 + i * 2,
      Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
      true,
    ),
  );

  return bytes;
}
export async function recordingWav(blob: Blob): Promise<string> {
  const context = new AudioContext();

  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const length = Math.min(Math.floor(audio.duration * 16000), 60 * 16000);
    if (length < 1600)
      throw new Error('Record a little longer before sending.');
    const offline = new OfflineAudioContext(1, length, 16000);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const bytes = pcmWav(rendered.getChannelData(0));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));

    return btoa(binary);
  } finally {
    await context.close();
  }
}
