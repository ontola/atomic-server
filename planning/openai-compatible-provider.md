# OpenAI-compatible AI provider

## Goal

Avoid adding a named provider (and ~N UI/settings/transport touch points) for every OpenAI-compatible gateway (OrcaRouter, Groq, LiteLLM, LM Studio, custom proxies).

Supersedes the approach in https://github.com/ontola/atomic-server/pull/1258 (named `OrcaRouter` enum value).

## Design

- Keep **OpenRouter** and **Ollama** as first-class providers (their auth, listing, and streaming extras differ).
- Add one generic **`openai-compatible`** provider: user-supplied base URL + API key.
- Share **model construction** (`createLanguageModel`) between `useGetModel` and `ClientOnlyTransport`.
- Share **model value** helpers (`provider:id` serialize/parse, display labels) so ComboBox wiring does not grow ternaries.
- Optional **presets** (e.g. OrcaRouter) only fill the base URL / placeholder — they are not new enum values.

## Checklist

- [x] `AIProvider.OpenAICompatible`
- [x] Shared `createLanguageModel` + model-value helpers
- [x] Settings + setup panel (base URL, API key, presets)
- [x] Model list via `{baseUrl}/models`, selector tab, chat ComboBox
- [x] Context length from models list when present
- [x] Docs + changelog
- [x] Tests / typecheck / lint
