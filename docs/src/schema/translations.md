{{#title Atomic Data Translations & Localization}}
# Translations & Localization

Atomic Data supports two complementary mechanisms for translated content, split by *what varies per language*:

| Content shape | Mechanism |
| --- | --- |
| Whole-entity content that diverges per language: a blog post, a document, a page with its own URL and SEO metadata | **Document-level**: one resource per language, linked with `translationOf` |
| Shared-structure content with short strings inside: labels, buttons, feature cards, product names | **Field-level**: the [`LocalizedText` datatype](datatypes.md#localizedtext) |

Language tags are [BCP 47](https://www.rfc-editor.org/rfc/bcp/bcp47.txt) tags, e.g. `en`, `nl`, `de-CH`.

## Document-level: one resource per language

A translation is an ordinary resource. It carries:

- `https://atomicdata.dev/properties/language` — the language its content is written in.
- `https://atomicdata.dev/properties/translationOf` — the canonical resource it translates. The canonical resource is the one *without* `translationOf`; it carries `language` too.

```json
[
  {
    "@id": "https://example.com/blog/hello-world",
    "https://atomicdata.dev/properties/language": "en",
    "https://atomicdata.dev/properties/name": "Hello world",
    "https://atomicdata.dev/properties/description": "Our first post."
  },
  {
    "@id": "https://example.com/blog/hallo-wereld",
    "https://atomicdata.dev/properties/language": "nl",
    "https://atomicdata.dev/properties/translationOf": "https://example.com/blog/hello-world",
    "https://atomicdata.dev/properties/name": "Hallo wereld",
    "https://atomicdata.dev/properties/description": "Onze eerste post."
  }
]
```

Because a translation is a full resource, everything that works on resources works per language: it has its own path/slug (`/en/about` vs `/nl/over`), its own edit rights (grant a translator write on just the `nl` resource), its own publication state (an unpublished translation is simply a resource in a private folder), and its own history.

Finding all translations of a resource is a reverse query on `translationOf`.

A property *missing* on a translation falls back to the canonical resource's value at render time. Translators should therefore only set the properties they actually translate — shared fields (a cover image, an author link) live once, on the canonical resource, and cannot drift.

## Field-level: the `LocalizedText` datatype

For short strings inside a shared structure, duplicating the whole resource per language is wasteful. A Property with the [`LocalizedText`](datatypes.md#localizedtext) datatype holds all translations of one value:

```json
{
  "@id": "https://example.com/features/sync",
  "https://example.com/properties/tagline": {
    "en": "Fast sync",
    "nl": "Snelle synchronisatie"
  }
}
```

The structure (order, icons, links, relations) exists once; only the strings vary. Internally the value is a CRDT map keyed by language tag, so two translators editing different languages at the same time merge without conflict.

## Scope configuration

A site or scope root (e.g. a Website or Drive) declares:

- `https://atomicdata.dev/properties/defaultLanguage` — the fallback language, and the language assumed for content without a `language` tag.
- `https://atomicdata.dev/properties/languages` — (optional) the published languages, as a JSON array of tags. A hint for language pickers and generated routing.

## Language resolution

Clients resolve a preferred language `L` with the same chain everywhere:

1. exact tag (`nl-BE`)
2. primary subtag (`nl`)
3. the scope's `defaultLanguage`
4. `en`
5. the first available language

In `@tomic/lib` this is the `localizeText(value, preferred, defaultLanguage?)` helper; in Rust it is `Value::to_localized_string`.

## What the GUI supports today

- **LocalizedText columns** in [Tables](../atomicserver/gui/tables.md): per-language input, language switcher, and optional split-by-language columns.
- **Website templates** can declare `defaultLanguage` / `languages` and ship multi-locale starter content.
- **Document-level** `language` + `translationOf` are in the data model; a dedicated "Translate this page" / translations bar UX is still landing. Until then you create sibling resources and set the properties manually (or via the assistant).

UI chrome strings in the data-browser (menus, buttons) are localized separately via the app's own i18n tooling (Wuchale) and are unrelated to content `LocalizedText`.

## History

An earlier concept on this page (`TranslationBox`, a property per language under `https://atomicdata.dev/languages/{tag}`) was never implemented and is superseded by the model above.
