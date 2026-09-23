import { useEffect, useState } from 'react';
import { useAISettings } from './AISettingsContext';
import { SettingsSection } from '@components/Settings';
import { Column } from '@components/Row';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import { BasicSelect } from '@components/forms/BasicSelect';
import { MicrophoneSelect } from './MicrophoneSelect';

type Model = { id: string; name: string };

export default function SpeechSettings() {
  const {
    voiceEnabled,
    setVoiceEnabled,
    transcriptionModel,
    setTranscriptionModel,
    openRouterApiKey,
  } = useAISettings();
  const [models, setModels] = useState<Model[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!voiceEnabled || !openRouterApiKey) return;
    const controller = new AbortController();
    setFailed(false);
    // Dedicated transcription models, not general audio-capable chat models.
    void fetch(
      'https://openrouter.ai/api/v1/models?output_modalities=transcription',
      { signal: controller.signal },
    )
      .then(async response => {
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!Array.isArray(body.data)) throw new Error();
        setModels(
          body.data.filter(
            (model: Model) =>
              typeof model.id === 'string' && typeof model.name === 'string',
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });

    return () => controller.abort();
  }, [voiceEnabled, openRouterApiKey]);
  const options = models.some(model => model.id === transcriptionModel)
    ? models
    : [{ id: transcriptionModel, name: transcriptionModel }, ...models];

  return (
    <SettingsSection
      label='Speech-to-text'
      childSearchKeywords='voice microphone stt transcription'
    >
      <Column gap='0.5rem'>
        <CheckboxLabel>
          <Checkbox checked={voiceEnabled} onChange={setVoiceEnabled} />
          <span>Enable voice input</span>
        </CheckboxLabel>
        {/* Two conditionals, not one fragment: wuchale then reads the
            transcription fragment below as a message it never extracts, and
            it renders nothing. */}
        {voiceEnabled && <label htmlFor='voice-microphone'>Microphone</label>}
        {voiceEnabled && <MicrophoneSelect id='voice-microphone' />}
        {voiceEnabled &&
          (openRouterApiKey ? (
            <>
              <label htmlFor='transcription-model'>Transcription model</label>
              <BasicSelect
                id='transcription-model'
                value={transcriptionModel}
                onChange={event => setTranscriptionModel(event.target.value)}
              >
                {options.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </BasicSelect>
              {failed && (
                <span>
                  Could not load models. Your saved model is still selected.
                </span>
              )}
            </>
          ) : (
            <span>
              Atomic credits use Whisper 1. Add your OpenRouter key to choose
              another model.
            </span>
          ))}
      </Column>
    </SettingsSection>
  );
}
