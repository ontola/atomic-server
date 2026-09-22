# Account entry and unlock routes

The portal session identifies the cloud account. The app's local agent unlocks
the workspace. Either can exist without the other; a portal URL or session must
not prevent signing in with an agent secret, including while offline.

## Implementation

- [GettingStartedFlow](src/views/getting-started/GettingStartedFlow.tsx): welcome, secret/passkey unlock, restore and post-unlock navigation. The unconditional portal redirect was here.
- [IdentityReconcileGate](src/components/IdentityReconcileGate.tsx): compares the portal account with the local agent and resolves identity conflicts. Stale asynchronous results previously redirected after sign-in.
- [SettingsAgent](src/routes/SettingsAgent.tsx): requires an unlocked agent before managing the backup/passkeys.
- [WelcomeRoute](src/routes/WelcomeRoute.tsx): validates the internal sign-in continuation parameters.
- [Portal App](../../../atomic-saas/portal/src/App.tsx): `checkAuth`, `enterApp` and `addPasskey` control session detection, dashboard routing and the handoff to app settings.

## Routes

| Entry / state | Destination and behavior |
| --- | --- |
| App root, local agent and drive available | Open the drive (`RootRoutes`). |
| App root without a local agent; sign-out; device lock | Welcome stays in the app. Sign in offers cached passkeys, recovery and agent-secret entry. |
| Welcome → Create account, hosted distribution | Explicit navigation to the portal for email verification. |
| Welcome → Create account, self-hosted | Local creation, unless the node disallows it. |
| Portal verification for an account without existing data | `/app/welcome?from_portal=true&email=…` opens identity creation. |
| Private drive opened without an agent | `/app/welcome?next=<subject>` opens sign-in; successful unlock returns to that drive. |
| Secret / passkey / recovery-code unlock, workspace present | Open the requested or personal drive. |
| Unlock, workspace absent | Try hosting and encrypted vault restore; if still absent, show Connect device. Do not open an empty workspace as if restored. |
| Portal Add passkey, no recovery backup | Register the portal passkey in the portal. |
| Portal Add passkey, recovery backup exists | Open `/app/agent` to manage the encrypted account backup. |
| `/app/agent` without a local agent | `/app/welcome?return_to=agent` opens sign-in, then returns to `/app/agent`. Managing a passkey does not require restoring all workspace data. |
| Portal account differs from the local agent, disposable local identity | Reconciliation opens `/app/welcome?step=signin`; preserve `return_to=agent` when coming from settings. |
| Same mismatch, local identity has a workspace | Ask before switching; choosing the account follows the unlock route above. |
| Sign-in explicitly selects a different secret | Release the conflicting portal session using the existing secret-sign-in handler. Outdated reconciliation results cannot navigate, bind an identity, or repoint the server. |
| Invitation for an existing account | `invite` opens recovery and resumes the invitation after unlock. Invitations and requested drives take precedence over settings continuation. |
| Portal `/signin`, valid existing session | Replace URL with `/dashboard` and load the account. |
| Portal `/signin`, anonymous | Keep the sign-in form. |
| Email link supplied | Show the existing link-confirmation step, then exchange that link; never fall back to an older session after rejection, including on reload. |
| Portal public pages, billing, device linking, invitations | Preserve their existing destinations rather than applying the generic sign-in redirect. |

`return_to` accepts only the named value `agent`, never an arbitrary URL.
Welcome's Back buttons can explicitly return to the portal; merely rendering
welcome does not leave the app.

## Failure mechanism and repair

Welcome used to call `location.replace(portal + '/dashboard')` whenever its
step was `welcome`. Settings, lock, resource guards and reconciliation all use
that same screen, so returning to welcome could immediately undo the app entry.
Its hosted rendering branch also hid the sign-in controls behind a spinner.
Removing both behaviors makes local unlock reachable again.

`IdentityReconcileGate` also applied results from three asynchronous reads after
the identity or route had changed. Effect cancellation and a
check against the current store agent now discard those results. Mounted tests
reproduce redirects after a newer sign-in, a workspace check completing after
entering welcome, and an old hosting result changing the new agent's server.

## Verification and limits

Mounted component tests cover hosted/self-hosted welcome, secret entry,
settings continuation with and without local data, requested-drive priority,
invitation continuation, new-account handoff, arbitrary return-URL rejection,
missing-data fallback and stale reconciliation. Helper tests cover session
logout races, hosting reconciliation and private-drive guards.

Portal Chromium tests cover existing/anonymous sessions, reload, public pages,
and rejected/fresh email links. Their API responses are controlled fixtures.
These checks do not establish that production has deployed this code, or that
a real authenticator has successfully registered a new passkey on atomic.place.
