# Security policy

Atomic-Server is a database and web server that people expose to the internet, so we take reports about it seriously. Thank you for taking the time to send one.

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security problem.

Report it privately, in one of two ways:

1. **GitHub private vulnerability reporting** (preferred): open the [Security tab](https://github.com/ontola/atomic-server/security/advisories/new) of this repository and choose *Report a vulnerability*. This creates a private advisory where we can discuss the report, share a patch and credit you.
2. **E-mail**: <joep@ontola.io>.

A useful report contains:

- the affected component (`atomic-server`, `atomic-lib`, the `@tomic/*` JavaScript libraries, the data browser, the desktop or mobile app) and the version or commit you tested;
- the steps to reproduce, ideally against a server you control, with the request bodies involved;
- the impact you see: what an attacker gains, and what they need to have (an account, write access to a drive, network position) to get it;
- if you have one, a suggested fix.

Please test against your own instance. The public demo at [atomicdata.dev](https://atomicdata.dev) holds other people's data; do not use it as a target.

## What happens next

- We confirm that we received the report within a few working days.
- We verify it, decide on a severity and work on a fix on the `develop` branch. We keep you informed in the advisory or by e-mail, and are happy to have you re-test a fix before it ships.
- Once the fix is released we publish the GitHub advisory, request a CVE and credit you in the advisory and in [`CHANGELOG.md`](./CHANGELOG.md), unless you prefer to stay anonymous.
- We aim to release a fix and publish the advisory within 90 days of the report. If you need a shorter or longer window, say so in the report and we will try to accommodate it.

We do not run a bug bounty programme and cannot offer payment for reports.

## Supported versions

Security fixes land on `develop` and ship in the next release of the current line. Only the most recent release receives fixes; older releases, and pre-releases older than the latest one, do not. If you run Atomic-Server, keep it on the latest version.

| Version | Supported |
| --- | --- |
| latest release of the current line (`0.41`) | yes |
| `0.40.3` | until the first non-beta `0.41` release |
| anything older | no |

## Scope

In scope is anything in this repository: the server, the Rust library, the JavaScript libraries, the data browser, the desktop and mobile apps, and the build and release pipeline.

Some things are not vulnerabilities in Atomic-Server, or we cannot act on them here:

- A finding in a dependency without a path to it that this project actually exposes. Report those upstream; if you can show a reachable path, that report is in scope.
- Flooding a server that runs with its rate limits switched off (`--write-rate-limit 0`, `--anonymous-write-rate-limit 0`), or with no reverse proxy in front of it. The defaults are the supported configuration.
- Anything that needs a compromised server host, a compromised agent private key or physical access to the device.
- Reports produced by automated scanners without a demonstrated impact.

If you are unsure whether something counts, send it anyway. We would rather read a report we close than miss one.

## Past advisories

Published advisories are listed on the [Security tab](https://github.com/ontola/atomic-server/security/advisories) and, with their fixes, in [`CHANGELOG.md`](./CHANGELOG.md).
