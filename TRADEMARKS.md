# Atomic trademark policy

The Atomic software is MIT licensed. The Atomic **marks** are not.

This split is intentional and it is the standard arrangement for open source
projects that intend to remain open: the MIT licence gives away the code, and
trademark keeps the *name* attached to software that genuinely comes from this
project. You can fork Atomic Server, change it however you like, and sell it.
You cannot call the result Atomic Server.

> This document states project policy. It is not legal advice.

## The marks

| Mark | Type | Applies to |
| --- | --- | --- |
| **Atomic Data** | word | the specification |
| **Atomic Server** | word | the server and its apps |
| **Atomic Canvas** | word | the infinite-canvas app |
| The ring-and-orb device | figurative | all of the above |
| **Ontola** | word | the company |

Canonical artwork lives in [`brand/src/`](./brand/src/) and is the only
approved source. Everything else in the repo is generated from it by
`node brand/generate.mjs` — never trace, redraw or hand-edit a copy.

Owner: Joep Meindertsma / Ontola.io.

## Permitted and restricted use

See [`brand/LICENSE`](./brand/LICENSE) for the operative terms. In short:
referring to Atomic is always fine; shipping a modified build under our name
is not. Permission requests go to joep@ontola.io.

## Registration status

**None of these marks are registered yet.** Until they are, they are unregistered
marks — enforceable in some jurisdictions on a use basis, but far weaker and more
expensive to defend than a registration.

Practical notes for closing that gap:

- **Use `™`, not `®`.** `®` is reserved for registered marks and using it before
  registration is itself an offence in several jurisdictions, including the EU
  and US. Switch only once a registration certificate issues.
- **Where.** Ontola is Dutch, so the realistic options are a Benelux
  registration via [BOIP](https://www.boip.int) (cheapest, Benelux only) or an
  EU trade mark via [EUIPO](https://euipo.europa.eu) covering all 27 member
  states for roughly EUR 850+ per class. A US registration via USPTO matters
  separately if US customers are a target, since US rights are largely
  use-based and territorial.
- **Which classes.** For this business the relevant Nice classes are almost
  certainly **class 9** (downloadable software) and **class 42** (SaaS, PaaS,
  software design and development). Class 35 may matter if the marks get used
  for business/data services.
- **Which marks to prioritise.** The figurative ring-and-orb device is the
  strongest candidate — distinctive and clearly ours. Word marks built on
  "Atomic" are weaker, because "atomic" is close to descriptive in a data
  context and registries frequently refuse or narrow such applications. A
  **composite mark** (device + wordmark together) is usually the pragmatic way
  to get protection on the name.
- **Keep evidence of use.** Dated screenshots, release artifacts and this
  repository's history all establish first-use dates, which matter both for
  registration and for opposing later filings by others.

Getting this filed is a genuine business priority rather than a code change,
and is worth a conversation with a Benelux/EU trade mark attorney before
filing — a refused application is not refundable.
