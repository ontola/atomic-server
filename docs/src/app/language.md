# Interface language

Open **Settings** (`/app/settings`) and choose **Language** to use the
databrowser in English, Spanish, French, German, Dutch or Indonesian. Dutch
appears as **Nederlands** and Indonesian as **Bahasa Indonesia** in the picker.
Without a saved choice, the app uses a supported browser language, falling
back to English.
Your choice is saved in this browser for this app address.

Changing the interface language changes buttons, menus and explanatory text.
It does not translate your documents, drive names or other saved content.
For example, a drive you named “Disco Privado” keeps that name in every
interface language. The special **Private drive** label is interface text;
changing its language does not change sharing permissions.

Plugins supply their own interfaces and may support a different set of
languages. Resource content has its own [translation mechanisms](../schema/translations.md).

## Contributing translations

The UI catalogs are `browser/data-browser/src/locales/{en,es,fr,de,nl,id}.po`.
Wuchale extracts messages from frontend code. From `browser/data-browser`, run:

```sh
pnpm check:translations
node scripts/check-translations.mjs --json > translation-report.json
pnpm exec wuchale check --full
```

The first command checks every configured locale and exits unsuccessfully for
missing entries, empty translation forms, fuzzy drafts, duplicate entries,
incorrect language or plural-count metadata, or broken interpolation and
markup placeholders.
The JSON report includes every affected message and its source references.
The full Wuchale check also detects source messages that need extraction.
These checks do not call a translation service or change catalogs.

English is the source language. Keep numbered placeholders such as `{0}`,
numbered tags such as `<0>…</0>` and `<1/>`, and plural `#` count markers intact.
Translate complete sentences, including every plural form. Product names and
technical identifiers may legitimately remain unchanged; matching English
text is reported as a count, not automatically considered a missing translation.

Dutch has separate singular and plural forms. Indonesian uses one form for
all counts (`nplurals=1; plural=0;`). Its shared form must retain a variable
count: for example, English `1 Change` / `# Changes` becomes `# perubahan`,
so the number stays correct for zero, one and multiple changes.

After changing rendered source text, serve the affected views with Vite to
extract messages, then stop it, fill the new entries and review the catalog
changes. A production build compiles the saved catalogs; it does not fill
their missing translations. Do not run a dev
server and a build against the same catalogs at once. Verify a production
build in the target language: catalog checks cannot prove that every visible
string was extracted or that a translation is natural in context.
