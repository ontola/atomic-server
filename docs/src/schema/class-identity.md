{{#title Atomic Data: Class identity}}

# Class identity

_status: draft_

A Class is content-addressed, like a [Property](property-identity.md). Its ID is a hash of exactly three fields: the namespace it belongs to, its shortname, and the set of Properties it requires.

The namespace is the resource the Class belongs to: its `parent`, usually an Ontology. In the hash this field is called `ontology`.

Two Classes with the same namespace, shortname and required Properties are the same Class. Add or remove a required Property, rename the shortname, or move the Class to another namespace, and you get a new Class with a new ID. So `parent`, `shortname` and `requires` can never change after creation.

Everything else stays editable. In particular **`recommends` is not hashed**: adding a recommended Property to a Class does not make a new Class, because data written against the old shape is still valid against the new one. Adding a required Property does, because old data would stop being valid. A [Lens](lenses.md) maps data from an old Class or Property onto a new one.

## Identifier form

```
atomic:class:{hex}
```

`{hex}` is the 64 character lowercase hex output of BLAKE3, like `atomic:prop:{hex}` and `atomic:blob:{blake3-hex}` (see [Identifiers](../identifiers.md)).

Unlike properties there is **no `did:ad:class:` spelling**. The kind is newer than the `did:ad:` rename, so only `atomic:class:` is valid, and it is never rewritten to `did:ad:` for peers that predate the rename.

## What is hashed

The input is the JSON Canonicalization Scheme (JCS, RFC 8785) serialization of this object. It has these three keys and no others:

```json
{
  "ontology": "<ontology ID>",
  "requires": ["<property ID>", "..."],
  "shortname": "<shortname>"
}
```

JCS sorts the keys and removes whitespace, so the hashed bytes look like this:

```
{"ontology":"<ontology ID>","requires":["<property ID>"],"shortname":"<shortname>"}
```

A Class without required Properties hashes `"requires":[]`. A missing `requires` and an empty one are the same Class.

## Normalization

Apply these rules before hashing. Reject the input if a rule fails.

- **Ontology (the namespace).** Must not be empty. If it is a `did:ad:` identifier, rewrite it to its `atomic:` form. HTTP(S) ontology URLs are used as they are.
- **Shortname.** It must be a valid [slug](datatypes.md#slug): `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- **Requires.** Each member is one of:
  - an `atomic:prop:{hex}` ID. A `did:ad:prop:{hex}` member is rewritten to `atomic:prop:`. The hex must be 64 lowercase characters.
  - an `http(s)://` URL, used as it is. This is how a Class requires a core Property such as `https://atomicdata.dev/properties/name`.

  Any other identifier (a lens, another class, a bare name) is rejected. After normalization the members are sorted by byte order (so the order a Class lists them in does not matter) and a member that appears twice is rejected.

## Hash function

BLAKE3 in derive-key mode, with this context string:

```
atomic class identity v1
```

The context separates class IDs from property IDs and blob hashes. A class ID can never equal a property ID or blob hash, even if the bytes are the same.

```
hex = BLAKE3.derive_key("atomic class identity v1", jcs_bytes).to_hex()
id  = "atomic:class:" + hex
```

## What is not hashed

- **`recommends`.** Optional Properties can be added or removed without changing the Class.
- Labels, descriptions and translations.
- Constraints: allowed values, bounds, and `classtype` / linked `class` rules for a Property. These are value rules the Class holds for each Property, outside the hash. A Class that constrains a Property to link back to the same Class therefore does not create a cycle: the hash never depends on the content of another Class.
- Per-property **default values** used to initialize new records. A default describes record creation, not the shape of the Class, and is kept with the Class's per-property constraints or a separate defaults map, outside the hash.
- **Views** and all other presentation: view kind and configuration, default view, default sort order, filters, grouping, column order, aggregates, calculated columns and actions.
- `deprecatedProperties`, ordering and widget hints.
- Any future `replaces` link to an older term.

The identity is exactly `ontology` + `shortname` + sorted `requires` and nothing else. A Class can therefore gain defaults, views, recommended Properties, constraints or a new description without getting a new `atomic:class:` ID. Only changing the set of required Properties (or the namespace or shortname) does.

Descriptions and constraints can change while the ID stays, so a host may show different prose for a pinned ID, and a pinned ID proves the shape of the Class, not who published it. Provenance is the signer of the namespace Ontology.

## Verification

A Server rejects a commit that creates a resource with an `atomic:class:` subject unless the subject equals the ID computed from the `parent`, `shortname` and `requires` in that commit's resulting document. A later commit that changes `parent`, `shortname` or the set of `requires` is rejected too. Other changes, including `recommends`, are accepted subject to the usual rights.

A verifier given a subject, an ontology, a shortname and the required Properties normalizes the inputs, computes the ID, and compares it with the subject. A Class cannot be moved to the trash, since its parent is part of its ID.

## Test vectors

The shared fixture is [`lib/tests/fixtures/class-identity.json`](https://github.com/ontola/atomic-server/blob/develop/lib/tests/fixtures/class-identity.json). Every implementation must reproduce it (the Rust one and the TypeScript twin `browser/lib/src/class-identity.ts` do). It also lists inputs that must be rejected. The required Properties are the `name` (string) and `name` (slug) test vectors of [Property identity](property-identity.md).

| Case | Ontology | Shortname | Requires | ID |
| --- | --- | --- | --- | --- |
| no required properties | `atomic:ontologyGenesis` | `task` | none | `atomic:class:32ea82da62c4bb016fd04dd163819ed3a67c444c131c2e8c7195a245ffa4838b` |
| one required property | `atomic:ontologyGenesis` | `task` | `atomic:prop:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74` | `atomic:class:86ecb3e704eece30cbcf75b27d93ed59841a0bf4270e4e6630ed478a4f19f961` |
| two required properties | `atomic:ontologyGenesis` | `task` | `atomic:prop:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74`, `atomic:prop:d744c0c58cf42bff6246a015b5e1429c93f1ca505c3355dd84c695c8da6e6626` | `atomic:class:b957eb2e5ec1a154e5a1b15c5613bffaf868c7349e59897ec7d5bb7f145760f7` |
| requires order does not matter | `atomic:ontologyGenesis` | `task` | `atomic:prop:d744c0c58cf42bff6246a015b5e1429c93f1ca505c3355dd84c695c8da6e6626`, `atomic:prop:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74` | `atomic:class:b957eb2e5ec1a154e5a1b15c5613bffaf868c7349e59897ec7d5bb7f145760f7` |
| did:ad: ontology normalizes | `did:ad:ontologyGenesis` | `task` | `atomic:prop:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74` | `atomic:class:86ecb3e704eece30cbcf75b27d93ed59841a0bf4270e4e6630ed478a4f19f961` |
| did:ad:prop: member normalizes | `atomic:ontologyGenesis` | `task` | `did:ad:prop:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74` | `atomic:class:86ecb3e704eece30cbcf75b27d93ed59841a0bf4270e4e6630ed478a4f19f961` |
| another shortname | `atomic:ontologyGenesis` | `todo` | `atomic:prop:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74` | `atomic:class:580ff4d90ff82739a914b07e6f2961ba23a334b30b6ef7136b8bc6172b5235cd` |
| another ontology | `atomic:otherOntology` | `task` | `atomic:prop:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74` | `atomic:class:8d2a9f9f8411c63405169dee1a3d163120839620bf2360dd50343fe526991eb3` |
| https core member is hashed as is | `atomic:ontologyGenesis` | `task` | `https://atomicdata.dev/properties/name`, `atomic:prop:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74` | `atomic:class:fa73e5a48316efe94e390dc6aaace4e1749a4a4fa33a0657e643248add7a774d` |
| https ontology | `https://atomicdata.dev/ontology/core` | `task` | `https://atomicdata.dev/properties/name` | `atomic:class:ff7bd97c6b62c680c07c3a16e81a6db3ce682a717f762df631218beb7d699bdb` |

Rows 3 and 4 differ only in the order of `requires`, and rows 2, 5 and 6 differ only in how the same inputs are spelled, so they share an ID.
