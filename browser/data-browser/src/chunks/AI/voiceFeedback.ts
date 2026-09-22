// @wc-ignore-file
/** Quiet room -> 0, ordinary speech -> visible movement, bounded at 1. */
export function voiceLevel(samples: Float32Array): number {
  const rms = Math.sqrt(
    samples.reduce((sum, value) => sum + value * value, 0) /
      Math.max(1, samples.length),
  );

  return Math.max(0, Math.min(1, (rms - 0.008) * 8));
}

export function observeVolume(
  stream: MediaStream,
  update: (level: number) => void,
): () => void {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser); // Never connect the microphone to speakers.
  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  let level = 0;

  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    const next = voiceLevel(samples);
    level += (next - level) * (next > level ? 0.65 : 0.18);
    update(level);
    frame = requestAnimationFrame(tick);
  };

  void context.resume().catch(() => {});
  tick();

  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    analyser.disconnect();
    void context.close().catch(() => {});
  };
}

interface Recognition {
  processLocally: boolean;
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onerror: (() => void) | null;
  start(): void;
  abort(): void;
}
interface RecognitionConstructor {
  new (): Recognition;
  available?: (options: {
    langs: string[];
    processLocally: boolean;
  }) => Promise<string>;
}

/** Optional local draft only: never silently send audio to another cloud service. */
export function observeWords(update: (text: string) => void): () => void {
  const browser = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  const Constructor =
    browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  let stopped = false;
  let recognition: Recognition | undefined;

  if (Constructor?.available) {
    const lang = navigator.language || 'en-US';
    void Constructor.available({ langs: [lang], processLocally: true })
      .then(availability => {
        if (stopped || availability !== 'available') return;
        recognition = new Constructor();
        if (!('processLocally' in recognition)) return;
        recognition.processLocally = true;
        recognition.lang = lang;
        recognition.interimResults = true;
        recognition.continuous = true;

        recognition.onresult = event => {
          if (!stopped)
            update(
              Array.from(event.results, result => result[0]?.transcript ?? '')
                .join(' ')
                .trim(),
            );
        };

        recognition.onerror = () => {}; // Optional preview must not break recording.
        recognition.start();
      })
      .catch(() => {});
  }

  return () => {
    stopped = true;

    if (recognition) {
      recognition.onresult = null;

      try {
        recognition.abort();
      } catch {}
    }
  };
}
