# Single OpenAI-compatible AI endpoint

Supersedes https://github.com/ontola/atomic-server/pull/1258 and the earlier multi-provider registry approach.

## Model

- One config: `baseUrl` + optional `apiKey`
- One client: `@ai-sdk/openai-compatible`
- One model list: `GET {baseUrl}/models`
- Presets only fill the form (OpenRouter, Ollama, OrcaRouter, Groq, OpenAI)
- `AIModelIdentifier` is `{ id }` (legacy `{ id, provider }` still accepted when reading storage)
- Keep OpenRouter OAuth + credits as optional UI when the base URL is OpenRouter

## Done

- [x] Collapse transport / settings / setup / model picker
- [x] Remove `@openrouter/ai-sdk-provider` and `ollama-ai-provider-v2`
- [x] Migrate old localStorage keys
- [x] Docs + changelog
