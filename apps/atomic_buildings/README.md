# AtomicBuildings

A Flutter app that holds a digital twin of a house on Atomic Data: storeys,
rooms and walls on a 2D plan, the sources the twin came from (photos, floor
plans, notes), and the questions an AI asks when it is unsure. Atomic is the
storage and the engine; the AI is just another agent writing commits with
`origin = ai`, and a person confirms or rejects what it proposes.

The design is in the schema proposal (`atomic-buildings/schema-proposal.md`).

## Layout

- `lib/src/terms.g.dart`: generated constants for the `building-*` classes and
  `bldg-*` properties (`BuildingClass.space`, `Bldg.storey`). Regenerate with
  `dart run tool/gen_terms.dart [path/to/atomic-plugins/ontology]` (default
  `../../../atomic-plugins/ontology`, a sibling checkout of atomic-server).
- `lib/src/geometry.dart`: the geometry JSON (`wallAxis`, `extrusion`,
  `opening`, `mesh`), validated in Dart.
- `lib/src/repository.dart`: `BuildingRepository`, pure Dart over a `Store`.
  Every resource except a Home has the Home as `parent` (the permission
  anchor); containment is a `bldg-*` link, never the parent.
- `lib/src/roomplan.dart`, `lib/src/room_scanner.dart`: the room-scan JSON
  contract, its import into the twin, and the scanner interface.
- `lib/ui/`: Homes list, then per Home one full-screen chat; Plan, Sources and
  Questions are screens opened from the title bar menu. The
  widgets take a `BuildingRepository`, so tests run on `InMemoryBackend`.

## Chat

A Home opens as one chat (`atomic_chat`'s `ChatScreen`, no new chat UI). The AI
asks questions; the person answers with text, photos (library or camera),
PDFs and other files, or a room scan. The title bar has the menu (Plan,
Sources, Questions; a badge counts open questions) and the account button (the
shared Atomic user panel). The composer's attach sheet has Scan room on devices
that can scan.

- **Tools** (`lib/src/building_tools.dart`; results are JSON, bad input comes
  back as `{ok: false, error}`, nothing is written then): `list_building`,
  `add_space`, `add_wall`, `add_opening`, `ask_question`, `answer_question`,
  `record_evidence`, `connect_rooms`. Everything the AI adds is `origin = ai`,
  `reviewState = proposed`, with `createdByRun` the AnalysisRun of that chat
  turn (made at the turn's first change, described at its end). `source` on an
  `add_*` call records Evidence. The prompt (`buildingPrompt`) asks for one real
  measurement first, forbids unsupported measurements and says to propose, not
  assert; `scaleFixed` in the state is true once a measure question is answered
  or a scan exists, and `add_*` results warn until then.
- **Questions** are Question resources (Questions screen) and are also asked in
  the chat text; `answer_question` closes one and records Evidence.
- **Attachments** become a Source each (photo, floorplan or pdf by type and
  name, note for text) when the message is stored. Images go to the model as
  image parts; if the model fails on a message with an image before answering,
  the answer is repeated without it, the chat says so, and images are left out
  from then on. PDFs are kept but the model cannot read them (it is told).
- **Scan room** runs `RoomScanner`, then `importScannedRoomChecked`. A confident
  placement is imported and the chat summarizes it and asks the room's use (also
  a Question). When the placement is not confident nothing is imported, the
  scan is held, a text Question is created and the chat asks which room and
  door it connects to; the AI then calls `connect_rooms(new_room,
  existing_room, via_door?)` (`alignScannedRoom` restricted to that room and
  door). Confident: imported, confidence returned. Otherwise it returns
  `needsDecision`, the options and their confidence; the AI describes them in
  the chat and calls again with `placement` (`best`, `alt_N`, `as_scanned`).
  Held scans live in memory only.
- **Storage.** The chat is an AI-chat resource under the Home. Its messages
  are JSON in one property (the typed store cannot write the web app's
  `ChatLog` pages), so the web app lists the chat without messages.
- **Account.** The AI is the atomic.place account whose identity is this
  device's agent (`lib/src/agent_account.dart`: agent sign-in, no saved
  session, sign-up by email). Without one the chat shows the package's "needs
  an account" notice and no composer, so Scan room is not reachable either.

`AssistantApi` (`lib/src/building_assistant_api.dart`): real are `hostedAi`,
`signUpForAi`, `newChat`, `addEntry`, `addMessage`, `chatEntries`, `messages`,
`resourceText`, `renameResource`; `drives`, `recentResources`, `favorites`,
`search`, `resourceIcons`, `noteOpened`, `agentName` answer empty; the rest
(`chats`, conversations, chat rooms, activity, notifications, `createResource`,
`webUrl`, `embedCall`) throw `UnsupportedError`. The breadcrumbs under the chat
title stay empty because of `embedCall`.

`atomic_chat` got small additions for this: `ChatScreen.actions` and
`attachActions` (`AttachAction`), `AttachmentPicker.keeps` (a picker keeps
files the AI cannot read, such as PDFs), and a scrollable attach sheet.

Unverified: everything against the real portal and hosted model (agent
sign-in, the agent secret format from `Identity.secret`, whether the model
takes image parts, tool-call quality and the prompt), the iOS permission
strings, image_picker and file_picker on devices, and the Scan room flow on a
real iPhone. Attached bytes are not stored: the typed store has no File upload
yet, so a Source has name, type and size only (and the picture is gone from the
chat after a restart). The web view, voice and speech parts of `atomic_chat`
come along as dependencies but are unused.

## Run

```
cd apps/atomic_buildings
flutter pub get
flutter test && flutter analyze
flutter run -d macos      # or an Android device or emulator, or iOS
```

The first build compiles the Rust node (`atomic_lib`) through the
`atomic_store_flutter` plugin, about 10 minutes cold; it needs a Rust toolchain
via rustup, and on Android the NDK. macOS needs Apple Silicon and macOS 12. The
platform folders already carry the settings that plugin asks for (see its
README): deployment targets, the Podfiles and the network entitlements. For a
stable keychain identity across debug builds set a development team in Xcode.
iOS and macOS have only been configured, not built or run.

## Scanning rooms (iPhone Pro)

Apple RoomPlan scans a room with LiDAR and returns parametric walls, doors,
windows, openings and objects. The Plan tab shows a **Scan room** button when
the device supports it; the result becomes proposals on the selected storey.

Requirements: an iPhone or iPad Pro with LiDAR, iOS 16 or later (the iOS
deployment target is 16.0), and a camera permission (`NSCameraUsageDescription`
is set). The native side is `ios/Runner/RoomScanPlugin.swift`, a method channel
`io.ontola.atomic_buildings/roomscan` with `isSupported` and `scan`; `scan`
returns this JSON as a string, or null when cancelled:

```
{ "name": "Living room",            // optional
  "storeyHeight": 2.6,              // optional, metres; else the tallest wall
  "surfaces": [{ "category": "wall|door|window|opening|floor|ceiling",
                 "id": "UUID",
                 "transform": [16 floats],   // column-major, ARKit world, Y up, metres
                 "dimensions": [w, h, d],    // metres, local axes
                 "confidence": "low|medium|high",
                 "parentId": "UUID" }],      // optional, the hosting wall
  "objects": [{ "category": "table", "id": "UUID", "transform": [16 floats],
                "dimensions": [w, h, d], "confidence": "medium" }] }
```

`importScannedRoom` maps it to a Source (`mediaKind` `scan`), a completed
AnalysisRun (`RoomPlan`), one Space (usage `other`, boundary from the wall end
points) and Elements, all `origin = import`, `reviewState = proposed`,
confidence 0.3 / 0.6 / 0.9, with Evidence on the Source. Coordinates: ARKit
(x, y up, z) becomes plan (x, -z); a wall's axis is its centre line along its
local X axis, `w` long. A door or window is hosted by its `parentId` wall, else
the nearest wall; its offset is measured along that wall, its sill is its lower
edge above the lowest wall edge of the scan (the floor). Objects become
`IfcFurnishingElement` footprints. Floors and ceilings are not stored. Several
scans go into the same storey, each with its own Space.

### Connecting scanned rooms

Every scan has its own ARKit origin, so rooms must be placed against each
other. Two layers:

- **Dart (`lib/src/room_align.dart`, tested).** `alignScannedRoom(existing,
  incoming)` takes the rooms already on the storey (`loadPlacedRooms`, one per
  scan run) and the new scan, and makes one of its doors/openings coincide with
  a door/opening of similar width (within 15 cm) of a placed room: the host
  walls become collinear, the new room lies on the opposite side, no scaling.
  Candidates are rejected above 20 % footprint overlap and scored on overlap,
  width fit and wall collinearity; the result has a `confidence` and the
  distinct runner-ups in `alternatives`. `applyAlignment` moves a
  `ScannedRoom` (valid ARKit matrices). `importScannedRoom` does this by
  default (`align: true`) and, when the placement is not confident (no
  matching opening, or the runner-up scores within 15 %, e.g. two identical
  doors), imports the room as scanned. **UI:** call
  `importScannedRoomChecked` instead; if `result.needsDecision`, nothing was
  imported: show `result.reason`, offer `result.proposal` and its
  `alternatives` (preview them with `applyAlignment`), "place as scanned"
  (`Alignment.identity`) and cancel, then call it again with `alignment:`.
  Failure modes: windows are not matched, a shared door that was not scanned
  gives no match, rooms without a door in a shared wall (open plan) are not
  placed, and a scan whose walls are not one closed loop gets an approximate
  outline.
- **iOS (`RoomScanPlugin.swift`, never compiled).** The plugin keeps one
  `RoomCaptureView`/ARSession across scans and, on iOS 17, stops with
  `stop(pauseARSession: false)`, so later scans share the world. The JSON then
  has `sessionId` and `worldShared: true` (every scan after the first of a
  session); Dart reuses the first scan's placement for the session and skips
  door matching (the placement is remembered for the process only; after a
  restart it falls back to matching). `endSession` starts a new world (use it
  when changing storey), and `mergeRooms` (iOS 17, `StructureBuilder`) returns
  `{"rooms": [...]}` in one frame (`PlatformRoomScanner.mergeRooms`); nothing
  in the app calls it yet.

Unverified: the Swift plugin and the Xcode project edit were written without a
Mac and have never been compiled or run, so the RoomPlan API use (session
delegate, `RoomBuilder`, `parentIdentifier`, `floors`, `stop(pauseARSession:)`,
`captureSession.arSession`, `StructureBuilder`/`CapturedStructure.rooms`, and
that `run` on a kept session does not reset the origin) and the real transform
conventions of RoomPlan output are untested. The Dart side is tested against a
synthetic room only. `scan` as a `bldg-media-kind` and the run status
`completed` should be checked against the ontology enum descriptions (`scan` is
not listed there yet).

## Ontology status

The classes and properties come from the `ontology-kit` release v2 in
[atomic-plugins](https://github.com/ontola/atomic-plugins). That release is not
published yet: it lands with its open PR. Until it merges, the subjects in
`terms.g.dart` do not resolve over HTTP. The app does not need them to
resolve, because the local store accepts properties and classes it does not
know, but other apps will not see labels or datatypes for them. When the PR
merges, rerun the generator and check that `git diff` on `terms.g.dart` is
empty (`test/terms_test.dart` does this when the checkout is present).
