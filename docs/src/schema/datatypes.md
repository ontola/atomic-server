{{#title Atomic Data: Datatypes}}

# Atomic Schema: Datatypes

The Atomic Datatypes consist of some of the most commonly used [Datatypes](classes.md#Datatype).

_Note: Please visit <https://atomicdata.dev/datatypes> for the latest list of official Datatypes._

## Slug

_URL: `https://atomicdata.dev/datatypes/slug`_

A string with a limited set of allowed characters, used in IDE / Text editor context.
Only letters, numbers and dashes are allowed.

Regex: `^[a-z0-9]+(?:-[a-z0-9]+)*$`

## Atomic URL

_URL: `https://atomicdata.dev/datatypes/atomicURL`_

A URL that should resolve to an [Atomic Resource](../core/concepts.md#Resource).

## URI

_URL: `https://atomicdata.dev/datatypes/URI`_

A Uniform Resource Identifier.
Could be HTTP, HTTPS, or any other type of schema.

Examples:

```
https://example.com/1
file://home/user/file.txt
mailto:user@example.com
```

## String

_URL: `https://atomicdata.dev/datatypes/string`_

UTF-8 String, no max character count.
Newlines use backslash escaped `\n` characters.

e.g. `String time! \n Second line!`

## Markdown

_URL: `https://https://atomicdata.dev/datatypes/markdown`_

A markdown string, using the [CommonMark syntax](https://commonmark.org/).
UTF-8 formatted, no max character count, newlines are `\n`.

e.g.

```md
# Heading

Paragraph with [link](https://example.com).
```

## Integer

_URL: `https://atomicdata.dev/datatypes/integer`_

Signed Integer, max 64 bit.
Max value: [`9223372036854775807`](https://en.wikipedia.org/wiki/9,223,372,036,854,775,807)

e.g. `-420`

## Float

_URL: `https://atomicdata.dev/datatypes/float`_

A 64 bit decimal number.
Max value: `1.7976931348623157e+308`

e.g. `-4.20`

## Boolean

_URL: `https://atomicdata.dev/datatypes/boolean`_

True or false, one or zero.

**String serialization**

`true` or `false`.

**Binary serialization**

Use a single bit one boolean.

1 for `true`, or 0 for `false`.

## Date

ISO date _without time_.
`YYYY-MM-DD`.

e.g. `1991-01-20`

## Timestamp

_URL: `https://atomicdata.dev/datatypes/timestamp`_

Similar to [Unix Timestamp](https://www.unixtimestamp.com/).
Milliseconds since midnight UTC 1970 Jan 01 (aka the [Unix Epoch](https://en.wikipedia.org/wiki/Unix_time)).
Use this for most DateTime fields.
Signed 64 bit integer (instead of 32 bit in Unix systems).

e.g. `1596798919` (= 07 Aug 2020 11:15:19)

## ResourceArray

_URL: `https://atomicdata.dev/datatypes/resourceArray`_

Sequential, ordered list of Atomic URIs.
Serialized as a JSON array with strings.

- e.g. `["https://example.com/1", "https://example.com/1"]`

## JSON

_URL: `https://atomicdata.dev/datatypes/json`_

Any valid JSON value.
Can be used to store arbitrary json data.

example:

```json
[
  "thing",
  {
    "name": "thing",
  },
  9883
]
```

## LoroDoc

_URL: `https://atomicdata.dev/datatypes/lorodoc`_

A [Loro CRDT](https://loro.dev) document binary, serialized as a base64 string.
Used for `loroUpdate` commit fields and other binary CRDT payloads.

```json
"bG9ybwAAAAAAAA..."
```

## LocalizedText

_URL: `https://atomicdata.dev/datatypes/localizedText`_

Translated strings for a single value, as a JSON object mapping [BCP 47](https://www.rfc-editor.org/rfc/bcp/bcp47.txt) language tags (e.g. `en`, `nl-BE`) to strings.

```json
{
  "en": "Hello world",
  "nl": "Hallo wereld",
  "de-CH": "Hallo Welt"
}
```

Clients resolve a language with this fallback chain: exact tag → primary subtag (`en-US` → `en`) → the scope's `defaultLanguage` → `en` → the first available tag.

Use `LocalizedText` for short user-facing text that varies per language while the rest of the resource is shared (labels, names, card text).
For long-form content that diverges per language (a blog post, a document), prefer one resource per language linked with `translationOf` — see [Translations](translations.md).

Stored internally as a native CRDT map keyed by language tag, so concurrent edits to *different* languages merge without conflict.
In JSON-LD, a `LocalizedText` property serializes with an `@language` container (a standard JSON-LD language map); in RDF it maps to language-tagged literals.
