{{#title Identity and workspaces}}

# Identity & workspaces

Atomic apps don't ask users for a password against your server. They create a cryptographic **agent** on the device and use that as identity. Workspaces (drives) are containers that hold the user's data and decide who can sync with whom.

## Agents

An agent is an Ed25519 keypair. The public half becomes a stable subject (`did:ad:agent:…`); the private half signs every commit. Whoever holds the secret can write as that agent — so treat secrets like passwords.

`LoginScreen` (from the [setup chapter](./2-setup.md)) calls this for you. Under the hood:

```dart
import 'package:atomic_lib/atomic_lib.dart';

await Atomic.init();

// First run: create agent + personal workspace, persist the session.
final result = await Atomic.setup(name: 'Ada');
print(result.agentSubject); // did:ad:agent:…
print(result.driveSubject); // workspace subject
// result.agentSecret — show once, let the user back it up

// Later launches:
final status = await Atomic.resumeSession(); // 'ok' | 'needs_sync' | null

// Or restore from a pasted secret:
await Atomic.signIn(secret: pastedSecret);
```

Need the current agent later?

```dart
final agent = await Atomic.activeAgent;
print(agent?.subject);
```

## Workspaces (drives)

A **drive** is the top-level container for a set of resources — think "this family's shared notes" or "this team's project". `Atomic.setup` already creates a personal drive. You can add more and switch between them:

```dart
final subject = await Atomic.createDrive('Team project');
await Atomic.setActiveDrive(subject);

print(Atomic.activeDrive);           // current workspace subject
final all = await Atomic.listDrives();
```

For a turnkey picker, drop in the built-in widget:

```dart
DriveSwitcher(
  onChanged: (drive) {
    // navigate into the new workspace
  },
)
```

Account, workspaces, and sync settings also live behind one dialog:

```dart
IconButton(
  icon: const Icon(Icons.settings_outlined),
  onPressed: () => showAgentSettings(context),
)
```

## Permissions, briefly

Access control is resource-scoped. The drive (and individual resources under it) carry `write` / `read` agent lists. Pairing and invites grant another agent rights on a drive — you don't invent a parallel ACL. See [Hierarchy and authorization](../hierarchy.md) for the full model; the Flutter SDK surfaces the common paths through pairing and server settings.

## Next

With an agent and a drive, you're ready to [create and sync data](./4-data.md).
