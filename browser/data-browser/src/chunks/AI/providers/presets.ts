/**
 * Known OpenAI-compatible gateways. Presets only fill the base URL / key
 * placeholder — they are not separate `AIProvider` enum values. Adding another
 * gateway should usually mean adding a row here, not a new provider.
 */
export type OpenAICompatiblePreset = {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyPlaceholder: string;
  /** Short blurb shown in settings / setup. */
  description: string;
  docsUrl?: string;
};

export const OPENAI_COMPATIBLE_PRESETS: OpenAICompatiblePreset[] = [
  {
    id: 'orcarouter',
    label: 'OrcaRouter',
    baseUrl: 'https://api.orcarouter.ai/v1',
    apiKeyPlaceholder: 'sk-orca-...',
    description:
      'OpenAI-compatible gateway with access to many models through one API key.',
    docsUrl: 'https://www.orcarouter.ai',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyPlaceholder: 'sk-...',
    description: 'Official OpenAI API.',
    docsUrl: 'https://platform.openai.com/docs',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyPlaceholder: 'gsk_...',
    description: 'Fast OpenAI-compatible inference.',
    docsUrl: 'https://console.groq.com/docs',
  },
];

/** Strip a trailing slash so `${baseUrl}/models` is always well-formed. */
export function normalizeOpenAICompatibleBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
