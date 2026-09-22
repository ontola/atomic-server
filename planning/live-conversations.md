# Voice chat with OpenRouter and SaaS credits

The first version is now push-to-talk, per user decision. Click the mic, record up to
60 seconds, then click the mic again to send. The toolbar shows only the mic icon;
status and errors are in its tooltip, and Escape cancels recording. Transcribe, run Atomic tools, speak the saved reply.
A configured personal OpenRouter key takes precedence: audio calls go directly to
OpenRouter and tasks use the configured chat provider, including document edits.
Without a personal key, the managed service uses its OpenRouter key and account credits.
The mic is always clickable; missing configuration opens AI setup.

- [x] Replace chat WebRTC control with one mic icon with recording, sending and cancellation states.
- [x] Convert browser recordings to mono 16 kHz PCM WAV; validate sample count and format on SaaS before spending credits.
- [x] Route transcription and speech through OpenRouter with pinned models, shared reservations, authoritative usage/generation settlement and no automatic retries.
- [x] Preserve transcript and answer even if playback fails. No separate replay control is shown.
- [x] Verify PCM encoding/cancellation and Chromium record -> transcript -> hosted chat -> playback without personal API key (provider/media mocked).
- [x] API built and restarted; 14 AI/accounting tests and the authentication/origin test pass.
- [ ] Real recording/transcription/tool action/playback requires ATOMIC_SAAS_AI_OPENROUTER_KEY in atomic-saas/.env. No local key is configured; the UI explains this instead of hiding the button.

Models verified against OpenRouter's dedicated catalogs: openai/whisper-1 for
transcription, google/gemini-2.5-flash for Atomic tasks, microsoft/mai-voice-2 for
speech. OpenAI's TTS example in the documentation was absent from the live speech
catalog. Reserve 100 USD micros/second of validated input audio and a conservative
22 USD micros/input UTF-8 byte for speech; settle from provider usage rather than
client claims. One credit = 1000 USD micros. Uncertain requests retain reservations;
existing background generation reconciliation retries later. Audio isn't stored by
Atomic. Replies longer than 1600 characters remain in chat but speech reads the first
1600 characters. Current voice is Harper; real multilingual quality remains untested.

The earlier GPT-Live implementation is retained but no longer exposed by this chat
control. Its API still requires the separate OpenAI key; it is not needed for this
version. No production deployment was performed.

Frontend typecheck passes after rebasing onto develop. Full-suite validation is tracked in ai-settings-validation.md.

Personal-key regression: ai-voice-byok.spec.ts passes record/cancel/transcribe/chat/speech with a test personal key and rejects any SaaS voice call. The local dev launch still supplies SaaS portal URLs, but those do not gate personal-key voice.

Recording feedback: actual microphone RMS controls icon size, color and halo; reduced-motion disables scaling. Optional on-device SpeechRecognition shows interim words above the mic when the browser already has the current language pack. No automatic cloud fallback or model download. The OpenRouter transcript remains authoritative. Unit tests cover noise threshold and canceled/unavailable recognition; Chromium verifies visual scaling and preview using simulated audio/recognition. Real device recognition availability remains browser-dependent.
