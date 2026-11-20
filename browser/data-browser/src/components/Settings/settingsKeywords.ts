/**
 * Extra search words per top-level settings section, keyed by its `?section=`
 * id. One list, read by the settings page's own search and by the ⌘K
 * palette's settings actions, so both find the same section for the same word.
 *
 * Plain words, not UI text: English plus the Dutch words people type for
 * signing in and out, since the section labels themselves are translated.
 */
export const settingsKeywords = {
  profile:
    'profile name avatar picture user agent sign out log out logout login log in uitloggen afmelden',
  account:
    'account security recovery passkey backup agent secret connected apps mcp device lock idle forget login log in sign in inloggen aanmelden atomic.place cloud vault cloud server plan subscription abonnement email recovery herstel e-mail credits',
  drive:
    'drive drives switch current my drives recently visited open url did new private',
  sync: 'sync devices device backup paired pairing connect another device local database restore offline',
  appearance:
    'appearance theme thema dark donker light licht color colour kleur taal sidebar icons pictures avatars language locale panels messages favorites shared with me templates ontology aichats hide templates',
  accessibility:
    'accessibility enable disable page transition animations view transitions motion',
  notifications: 'notify notifications alerts messages comments replies push',
  ai: 'ai enable features token usage panel sidebar openrouter ollama mcp server generative model chat provider api key local agents skills default voice microphone speech stt transcription privacy retention zdr generate titles follow up prompts temperature context tools system prompt content references transport headers',
  integration:
    'integration proxy catalog marketplace server url experimental plugins',
} as const;

export type SettingsSectionKey = keyof typeof settingsKeywords;
