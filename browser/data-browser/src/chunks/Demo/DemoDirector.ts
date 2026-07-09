// @wc-ignore-file
// (Wuchale: scripted demo dialogue, not app chrome — the injected
// translation-loader hook would throw outside React anyway.)
'use no memo';
import {
  StoreEvents,
  commits,
  core,
  dataBrowser,
  type PresenceEntry,
  type Store,
} from '@tomic/react';
import {
  PERSONAS,
  ROW_DOODLE,
  ROW_EXPLORE_BOARD,
  ROW_SAY_HI,
  createDemoMessage,
  type ChecklistStatus,
  type DemoManifest,
  type PersonaKey,
} from './demoWorkspace';
import { colorForAgent } from '../../components/Presence/AgentAvatar';
import { getOrCreateMeetingsFolder } from '../../helpers/standardLocations';
import { simulatePropEdit } from './simulatedEdits';
import { SimulatedTypist } from './SimulatedTypist';
import { YUSUF_LIVE_STROKES } from './moodboardStrokes';

/** Presence entries expire after 30s; refresh well inside that. */
const HEARTBEAT_MS = 10_000;
/** Base delay between typed characters; jittered per character, with an
 *  extra beat at word boundaries so the rhythm reads as human typing. */
const LETTER_MS = 35;

interface PersonaState {
  sessionId: string;
  /** Present = has an entry; absent = left (or not yet joined). */
  entry?: PresenceEntry;
}

/**
 * Plays the "Your first day" scenario (`planning/demo-experience.md`):
 * scripted teammates join the demo drive's presence channel, type into
 * the welcome doc, work the launch board, and wind down — while the
 * user is free to edit everything they touch.
 *
 * All state changes go through `applyIncoming` (simulated remote
 * peers); all awareness goes through `DrivePresenceManager.injectEntry`.
 * The run loop pauses while the tab is hidden so the user doesn't miss
 * the show, and every beat re-checks the resources it touches so a
 * user who deleted something is skipped over gracefully.
 *
 * Meeting: Mara starts a tour Meeting (drive `currentMeetings` + her
 * presence `session`), which lights up the top-bar Join banner. She
 * narrates each stop in the meeting chat and posts "Viewing …" trail
 * entries as she moves; the board's cards are the tour steps, so she
 * literally drags "Explore the kanban board" to Done while there.
 */
export class DemoDirector {
  private stopped = false;
  private started = false;
  /** Guards the reactive user-edit trigger against our own saves. */
  private selfSaving = false;
  /**
   * Subjects the director recently pushed deltas into, with timestamps.
   * An open editor re-saves imported remote ops (its debounced
   * save-on-change fires for persona edits too), which would satisfy
   * the "user edited something" trigger seconds after Mara types. A
   * save that lands right after we touched the same subject is that
   * echo, not the user.
   */
  private recentlyTouched = new Map<string, number>();
  private maraFollowed = false;
  /** The tour Meeting, created live once Mara "starts" it. */
  private meeting?: string;
  private userChatted = false;
  private userChatWaiters: Array<() => void> = [];
  /** The user's own Team-table row (guest DID or a created row), set at the
   *  team-table tour stop — the checkbox `completeSayHi` ticks. */
  private memberRow?: string;
  /** The "Say hi" payoff, memoized so it runs at most once no matter whether
   *  the linear script or the reactive chat listener triggers it first — and
   *  so the script's `await` joins the listener's in-flight run instead of
   *  racing ahead of it. */
  private sayHiPromise?: Promise<void>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private wanderTimer?: ReturnType<typeof setInterval>;
  private unsubscribePresence?: () => void;
  private unsubscribeSaved?: () => void;
  private personas: Record<PersonaKey, PersonaState>;

  public constructor(
    private store: Store,
    private manifest: DemoManifest,
  ) {
    this.personas = {
      mara: { sessionId: 'demo-session-mara' },
      yusuf: { sessionId: 'demo-session-yusuf' },
      pip: { sessionId: 'demo-session-pip' },
    };
  }

  public start(): void {
    if (this.started) return;
    this.started = true;

    // Keep the presence manager alive for the whole scenario, even
    // while no presence-consuming UI is mounted — and watch for the
    // user starting to follow Mara.
    this.unsubscribePresence = this.store
      .getPresence(this.manifest.drive)
      .subscribe(() => this.onPresenceChange());

    this.unsubscribeSaved = this.store.on(
      StoreEvents.ResourceSaved,
      resource => {
        if (this.selfSaving) return;
        if (!this.store.isLocalOnlySubject(resource.subject)) return;

        // The reactive trigger: a message the user posted into the
        // meeting chat ("say something"). An open editor re-saving
        // imported persona ops can't reach this — those aren't Messages
        // parented to the meeting.
        if (
          this.meeting &&
          resource.get(core.properties.parent) === this.meeting &&
          resource.hasClasses(dataBrowser.classes.message)
        ) {
          this.userChatted = true;
          this.userChatWaiters.forEach(resolve => resolve());
          this.userChatWaiters = [];
          // Own the "Say hi" payoff reactively — so it fires the moment the
          // user chats, even if that's outside the script's wait window
          // (e.g. they explored first). Idempotent via `sayHiDone`.
          void this.completeSayHi();
        }
      },
    );

    this.heartbeatTimer = setInterval(
      () => this.refreshPresence(),
      HEARTBEAT_MS,
    );

    void this.run().catch(e => {
      console.warn('[Demo] director stopped on error:', e);
      this.stop();
    });
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.wanderTimer) clearInterval(this.wanderTimer);

    const manager = this.store.getPresence(this.manifest.drive);

    for (const persona of Object.values(this.personas)) {
      if (persona.entry) manager.removeEntry(persona.sessionId);
      persona.entry = undefined;
    }

    this.unsubscribeSaved?.();
    this.unsubscribePresence?.();
    // Resolve any waiter so an in-flight `run()` unblocks and exits.
    this.userChatWaiters.forEach(resolve => resolve());
    this.userChatWaiters = [];
    void this.endTourMeeting();
  }

  // ─── The scenario ────────────────────────────────────────────────

  private async run(): Promise<void> {
    const { manifest } = this;

    // 0:00 — Mara and Yusuf are already here when the user lands.
    this.announceMara(manifest.welcomeDoc);
    this.announce('yusuf', { resource: manifest.moodboard });
    this.startYusufWander();

    await this.sleep(1_500);

    // 0:05 — the welcome doc is being written, and it reacts to the
    // user's arrival.
    await this.type('mara', manifest.welcomeDoc, [
      'Welcome to the Atomic Demo 👋',
      'This workspace is the demo: an onboarding board, a moodboard, team chat, docs and files — all real, all live, all editable.',
      'Oh — you’re here! 🎉 I’m about to start a tour to show you around.',
    ]);

    // The doc's feature tour: a todo list of onboarding steps.
    await this.appendWelcomeExtras();

    await this.sleep(2_000);

    // Mara starts a meeting: the top-bar Join banner lights up, and the
    // welcome doc closes with a link into it. Nothing is said in the
    // meeting yet — the greeting waits until the user actually opens it.
    await this.startTourMeeting();
    await this.appendMeetingLink();

    // Wait for the user to Join (open the meeting). If they don't within
    // ~25s, greet + play anyway so the log exists for whenever they do.
    await this.waitForJoin(25_000);

    if (this.stopped) return;

    // Now that they've (probably) opened the meeting, greet them.
    await this.narrate('Welcome to your onboarding tour! 👋');
    await this.sleep(1_400);
    await this.narrate(
      'I’ll walk you through everything right here — just follow along.',
    );
    await this.sleep(1_400);
    await this.narrate(
      'Every card on our board is a step in this tour. Let’s knock them out together 👇',
    );
    await this.sleep(1_500);

    // ── Tour stop 1: the board (the long, lively, meta stop) ──
    this.announceMara(manifest.checklist.table, {
      row: manifest.checklist.rows[ROW_EXPLORE_BOARD],
      column: manifest.checklist.statusColumn,
    });
    await this.narrate(
      'First stop: the board. Meta moment — every card here is a step in YOUR tour.',
    );
    await this.sleep(3_000);
    await this.narrate(
      'Watch — I’ll drag “Explore the kanban board” across as we, well, explore it.',
    );
    await this.sleep(1_500);
    await this.moveCard(
      'mara',
      manifest.checklist.rows[ROW_EXPLORE_BOARD],
      'Doing',
    );
    await this.sleep(2_500);
    await this.moveCard(
      'mara',
      manifest.checklist.rows[ROW_EXPLORE_BOARD],
      'Done',
    );
    await this.narrate('✅ one down. See how it jumps to the Done column?');
    await this.sleep(3_000);

    // Pip joins and adds a brand-new card, live.
    this.announce('pip', {
      resource: manifest.checklist.table,
      data: {
        row: manifest.checklist.rows[ROW_SAY_HI],
        column: manifest.checklist.statusColumn,
      },
    });
    await this.sleep(1_500);
    await this.postChat('pip', 'ooh a new teammate — adding a card 👋');
    await this.addChecklistCard('Invite the rest of your team', 'Todo');
    await this.sleep(3_000);
    await this.narrate(
      'Pip just dropped a new card on the board — cards, columns, everyone live. That’s the board.',
    );
    await this.sleep(3_000);

    // ── Tour stop 2: the moodboard, Yusuf drawing live ──
    this.announceMara(manifest.moodboard, { x: 340, y: 220 });
    await this.narrate('Next: the moodboard — Yusuf’s mid-doodle 🎨');
    void this.yusufFinishesTheFace();
    await this.sleep(7_000);
    await this.moveCard('mara', manifest.checklist.rows[ROW_DOODLE], 'Done');
    await this.narrate('And that ticks off “Doodle on the moodboard” ✅');
    await this.sleep(3_000);

    // ── Tour stop 3: the team table — the user becomes a row in it ──
    this.announceMara(manifest.team.table);
    await this.narrate(
      'One more stop: the Team table 👥 — everyone in the demo, live.',
    );
    await this.sleep(1_500);
    await this.narrate('And that includes you. Adding you to the roster ✍️');

    const memberRow = await this.ensureTeamRow();
    this.memberRow = memberRow;

    if (memberRow && !this.stopped) {
      // Mara's presence sits on the new member's Role cell while she
      // fills it in — the same cell ring a real collaborator would cast.
      this.announceMara(manifest.team.table, {
        row: memberRow,
        column: manifest.team.roleColumn,
      });
      await this.sleep(1_200);

      const rowResource = await this.getBeatResource(memberRow);

      if (rowResource) {
        this.touch(memberRow);
        await simulatePropEdit(
          this.store,
          rowResource,
          manifest.personas.mara,
          properties =>
            properties.set(manifest.team.roleColumn, 'Newest teammate 🎉'),
        );
      }

      await this.narrate('There — “Meet the team” is officially done ✅');
    }

    await this.sleep(3_000);

    // ── The ask ──
    this.announceMara(manifest.checklist.table);
    await this.narrate(
      'Last step 👇 say hi in this chat — that’ll tick off “Say hi in the meeting chat” for you.',
    );

    // Don't wind down until the user has actually said hi — ending the
    // meeting first leaves them chatting into a dead room and the "Say hi"
    // card never ticks. Wait generously (they may explore first); the
    // reactive listener also fires `completeSayHi` the moment they chat.
    const chatted = await this.waitForUserChat(4 * 60_000);

    if (this.stopped) return;

    if (chatted) {
      await this.completeSayHi();
    }

    await this.sleep(6_000);

    // Wind-down: end the meeting, team leaves one by one.
    await this.narrate('That’s the tour — the workspace is all yours now. 🚀');
    await this.endTourMeeting();

    this.leave('yusuf');
    await this.sleep(4_000);
    await this.postChat('pip', 'calling it — launch is tomorrow 🚀');
    this.leave('pip');
    await this.sleep(4_000);

    await this.type('mara', manifest.welcomeDoc, [
      'Everything here is editable, deletable, yours. Poke around!',
    ]);
    await this.sleep(2_000);
    this.leave('mara');
  }

  /** The welcome doc's feature tour: a live todo list and inline
   *  references to the board and the team table. */
  private async appendWelcomeExtras(): Promise<void> {
    const resource = await this.getBeatResource(this.manifest.welcomeDoc);

    if (!resource || this.stopped) return;

    const typist = new SimulatedTypist(
      this.store,
      resource,
      this.manifest.personas.mara,
      this.cursorUser('mara'),
    );

    const doc = this.manifest.welcomeDoc;

    const typeWords = (text: string) => this.typeText(typist, doc, text);

    const mention = (subject: string) => {
      this.touch(doc);
      typist.appendInline({
        type: 'atomic-data-resource-inline',
        attrs: { subject },
      });
    };

    try {
      await typist.start();

      // A todo list of onboarding steps, typed item by item — with live
      // references to the places each step happens.
      this.touch(doc);
      typist.appendContent({
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph' }],
          },
        ],
      });
      await typeWords('Explore the ');
      mention(this.manifest.checklist.table);
      await this.sleep(400);

      this.touch(doc);
      typist.appendTaskItem(false);
      await typeWords('Doodle on the ');
      mention(this.manifest.moodboard);
      await this.sleep(400);

      this.touch(doc);
      typist.appendTaskItem(false);
      await typeWords('Meet the ');
      mention(this.manifest.team.table);
    } finally {
      typist.stop();
    }
  }

  /** Close the welcome doc with a link to the tour meeting — the single
   *  most important thing to point a new teammate at. */
  private async appendMeetingLink(): Promise<void> {
    if (!this.meeting) return;
    const resource = await this.getBeatResource(this.manifest.welcomeDoc);

    if (!resource || this.stopped) return;

    const doc = this.manifest.welcomeDoc;
    const meeting = this.meeting;
    const typist = new SimulatedTypist(
      this.store,
      resource,
      this.manifest.personas.mara,
      this.cursorUser('mara'),
    );

    try {
      await typist.start();
      this.touch(doc);
      typist.appendParagraph();

      await this.typeText(
        typist,
        doc,
        'Your tour is starting — join it here: ',
      );

      if (this.stopped) return;

      this.touch(doc);
      typist.appendInline({
        type: 'atomic-data-resource-inline',
        attrs: { subject: meeting },
      });
    } finally {
      typist.stop();
    }
  }

  // ─── Presence ────────────────────────────────────────────────────

  /** Mara's announces carry `allowFollow` plus, once the tour meeting
   *  starts, its subject as `session` — so joiners open the meeting
   *  chat. Posts a "Viewing …" trail entry into the meeting as she
   *  moves. */
  private announceMara(resource: string, data?: unknown): void {
    const moved = this.personas.mara.entry?.resource !== resource;

    this.announce('mara', {
      resource,
      allowFollow: true,
      session: this.meeting,
      ...(data !== undefined ? { data } : {}),
    });

    // While the meeting is live, log each stop as a trail entry.
    if (moved && this.meeting) {
      void this.postTrail(viewingMessage(this.store, resource));
    }
  }

  private announce(key: PersonaKey, entry: Omit<PresenceEntry, 'agent'>): void {
    if (this.stopped) return;
    const persona = this.personas[key];
    persona.entry = { ...entry, agent: this.manifest.personas[key] };
    this.store
      .getPresence(this.manifest.drive)
      .injectEntry(persona.sessionId, persona.entry);
  }

  private leave(key: PersonaKey): void {
    const persona = this.personas[key];
    persona.entry = undefined;
    this.store.getPresence(this.manifest.drive).removeEntry(persona.sessionId);
  }

  private refreshPresence(): void {
    if (this.stopped) return;
    const manager = this.store.getPresence(this.manifest.drive);

    for (const persona of Object.values(this.personas)) {
      if (persona.entry) {
        manager.injectEntry(persona.sessionId, persona.entry);
      }
    }
  }

  /** Track whether the user has joined (their presence follows Mara),
   *  which gates the tour beat. */
  private onPresenceChange(): void {
    if (this.stopped) return;

    const snapshot = this.store.getPresence(this.manifest.drive).getSnapshot();
    this.maraFollowed = snapshot.some(
      item =>
        !item.sessionId.startsWith('demo-session-') &&
        item.following === this.manifest.personas.mara,
    );
  }

  /** Yusuf's cursor drifts around the moodboard while he's on it —
   *  a smooth random walk in canvas world coordinates. */
  private startYusufWander(): void {
    let x = 420;
    let y = 260;
    let vx = 30;
    let vy = 18;

    this.wanderTimer = setInterval(() => {
      const yusuf = this.personas.yusuf;

      if (
        this.stopped ||
        !yusuf.entry ||
        yusuf.entry.resource !== this.manifest.moodboard ||
        document.hidden
      ) {
        return;
      }

      vx += (Math.random() - 0.5) * 24;
      vy += (Math.random() - 0.5) * 24;
      vx = Math.max(-48, Math.min(48, vx));
      vy = Math.max(-48, Math.min(48, vy));
      x = Math.max(40, Math.min(900, x + vx));
      y = Math.max(40, Math.min(600, y + vy));

      this.announce('yusuf', {
        ...yusuf.entry,
        data: { x: Math.round(x), y: Math.round(y) },
      });
    }, 600);
  }

  // ─── State changes (simulated remote peers) ──────────────────────

  /** A beat's resource lookup must never kill the scenario: deleted or
   *  unresolvable resources (getResource can reject) just skip the beat. */
  private async getBeatResource(subject: string) {
    try {
      const resource = await this.store.getResource(subject);

      return resource.error ? undefined : resource;
    } catch {
      return undefined;
    }
  }

  private touch(subject: string): void {
    this.recentlyTouched.set(subject, Date.now());
  }

  /** The in-document caret identity: same name + deterministic color
   *  as the persona's avatar everywhere else. */
  private cursorUser(key: PersonaKey): { name: string; color: string } {
    return {
      name: PERSONAS[key].name,
      color: colorForAgent(this.manifest.personas[key]),
    };
  }

  /** Type `text` into the doc letter by letter, like a person would —
   *  each character lands as its own remote edit, with a jittered
   *  keystroke delay and a brief hesitation after each word. */
  private async typeText(
    typist: SimulatedTypist,
    docSubject: string,
    text: string,
  ): Promise<void> {
    // Array.from splits by code point, so multi-unit characters
    // (emoji, — ) land whole instead of as broken surrogate halves.
    for (const letter of Array.from(text)) {
      if (this.stopped) return;
      this.touch(docSubject);
      typist.appendText(letter);

      const wordBoundary = /\s/.test(letter) ? Math.random() * 130 : 0;
      await this.sleep(LETTER_MS + Math.random() * 40 + wordBoundary);
    }
  }

  /** Type paragraphs into a document, letter by letter. Skips silently
   *  if the user deleted the doc. */
  private async type(
    key: PersonaKey,
    docSubject: string,
    paragraphs: string[],
  ): Promise<void> {
    const resource = await this.getBeatResource(docSubject);

    if (!resource) return;

    // The typist reads as "someone is in this doc" — move the persona
    // there if they aren't already.
    const persona = this.personas[key];

    if (persona.entry && persona.entry.resource !== docSubject) {
      this.announce(key, { ...persona.entry, resource: docSubject });
    }

    const typist = new SimulatedTypist(
      this.store,
      resource,
      this.manifest.personas[key],
      this.cursorUser(key),
    );

    try {
      await typist.start();

      for (const paragraph of paragraphs) {
        if (this.stopped) return;
        this.touch(docSubject);
        typist.appendParagraph();

        await this.typeText(typist, docSubject, paragraph);

        if (this.stopped) return;

        await this.sleep(500);
      }
    } finally {
      typist.stop();
    }
  }

  /** Move a board card to a status column (kanban) as a persona. The
   *  persona "picks the card up" first — a dragging presence beat that
   *  makes the card pulse on every open board — then drops it with the
   *  status edit. */
  private async moveCard(
    key: PersonaKey,
    rowSubject: string,
    status: ChecklistStatus,
  ): Promise<void> {
    const row = await this.getBeatResource(rowSubject);
    const tag = this.manifest.checklist.statusTags[status];

    if (!row || !tag) return;

    this.announce(key, {
      ...this.personas[key].entry,
      resource: this.manifest.checklist.table,
      data: { row: rowSubject, dragging: true },
    });
    await this.sleep(1_200);

    if (this.stopped) return;

    this.touch(rowSubject);
    await simulatePropEdit(
      this.store,
      row,
      this.manifest.personas[key],
      properties => properties.set(this.manifest.checklist.statusColumn, [tag]),
    );

    // Dropped: presence stays on the card, no longer dragging.
    this.announce(key, {
      ...this.personas[key].entry,
      resource: this.manifest.checklist.table,
      data: { row: rowSubject },
    });
  }

  /** The "Say hi" payoff: welcome the user, tick their onboarding checkbox,
   *  and drag the "Say hi in the meeting chat" card to Done. Idempotent and
   *  callable from either the linear script or the reactive chat listener —
   *  whichever sees the user's first message first. Best-effort throughout
   *  (a missing meeting just skips the chatter; the card still moves). */
  private completeSayHi(): Promise<void> {
    if (!this.sayHiPromise) {
      this.sayHiPromise = this.runSayHi();
    }

    return this.sayHiPromise;
  }

  private async runSayHi(): Promise<void> {
    if (this.stopped) return;

    await this.narrate('there they are! welcome aboard 🎉');
    await this.postChat('yusuf', 'the new teammate speaks 🎉');

    // Tick their "Completed onboarding" checkbox — Mara flips it, the same
    // as a real teammate marking your onboarding done.
    if (this.memberRow) {
      const rowResource = await this.getBeatResource(this.memberRow);

      if (rowResource) {
        try {
          this.touch(this.memberRow);
          await simulatePropEdit(
            this.store,
            rowResource,
            this.manifest.personas.mara,
            properties =>
              properties.set(this.manifest.team.onboardingColumn, true),
          );
        } catch (e) {
          console.warn('[Demo] could not tick onboarding checkbox:', e);
        }
      }
    }

    await this.moveCard(
      'mara',
      this.manifest.checklist.rows[ROW_SAY_HI],
      'Done',
    );
  }

  /** Yusuf draws the second creature's face onto the moodboard, one
   *  stroke at a time (the body shipped with the template). */
  private async yusufFinishesTheFace(): Promise<void> {
    const moodboard = await this.getBeatResource(this.manifest.moodboard);

    if (!moodboard) return;

    const strokeDataProp = 'https://atomicdata.dev/ontology/canvas/strokeData';

    for (const stroke of YUSUF_LIVE_STROKES) {
      if (this.stopped) return;
      await this.sleep(700 + Math.random() * 400);

      const current = moodboard.get(strokeDataProp);
      const strokes = Array.isArray(current) ? [...current] : [];
      strokes.push(stroke as unknown as (typeof strokes)[number]);

      this.touch(this.manifest.moodboard);
      await simulatePropEdit(
        this.store,
        moodboard,
        this.manifest.personas.yusuf,
        properties => properties.set(strokeDataProp, strokes),
      );
    }
  }

  /** The user's row in the Team table: a guest's profile row (guest
   *  agents are created WITH one, subject = their agent DID), else a
   *  fresh member row named after their agent. Like `addChecklistCard`,
   *  a new row needs a user-signed genesis commit. */
  private async ensureTeamRow(): Promise<string | undefined> {
    const { team } = this.manifest;
    const agentSubject = this.store.getAgent()?.subject;

    if (agentSubject) {
      const profile = this.store.getResourceLoading(agentSubject);

      if (profile.get(core.properties.parent) === team.table) {
        return agentSubject;
      }
    }

    this.selfSaving = true;

    try {
      const agent = agentSubject
        ? await this.store.getResource(agentSubject)
        : undefined;
      const row = await this.store.newResource({
        parent: team.table,
        isA: team.rowClass,
        propVals: {
          [core.properties.name]: agent?.title ?? 'New teammate',
          [team.roleColumn]: 'New teammate',
          // First day — not onboarded yet; `completeSayHi` ticks this.
          [team.onboardingColumn]: false,
          // Latest createdAt → the ascending default sort lands it last.
          [commits.properties.createdAt]: Date.now(),
        },
      });
      await row.save();

      return row.subject;
    } catch (e) {
      console.warn('[Demo] could not add the user to the team table:', e);

      return undefined;
    } finally {
      this.selfSaving = false;
    }
  }

  /** New cards need a genesis commit, which only the user's agent can
   *  sign — so this one beat is authored by the user, guarded against
   *  the reactive edit trigger. */
  private async addChecklistCard(
    name: string,
    status: ChecklistStatus = 'Todo',
  ): Promise<string | undefined> {
    this.selfSaving = true;

    try {
      const tag = this.manifest.checklist.statusTags[status];
      const card = await this.store.newResource({
        parent: this.manifest.checklist.table,
        isA: this.manifest.checklist.rowClass,
        propVals: {
          [core.properties.name]: name,
          [this.manifest.checklist.statusColumn]: tag ? [tag] : [],
          [commits.properties.createdAt]: Date.now(),
        },
      });
      await card.save();

      return card.subject;
    } catch (e) {
      console.warn('[Demo] could not add board card:', e);

      return undefined;
    } finally {
      this.selfSaving = false;
    }
  }

  /** Persona-authored message in the Team chat. */
  private async postChat(key: PersonaKey, text: string): Promise<void> {
    if (this.stopped) return;
    this.selfSaving = true;

    try {
      await createDemoMessage(this.store, {
        parent: this.manifest.teamChat,
        author: this.manifest.personas[key],
        text,
      });
    } catch (e) {
      console.warn('[Demo] could not post chat message:', e);
    } finally {
      this.selfSaving = false;
    }
  }

  /** Mara-authored meeting trail entry (a "Viewing …" event). */
  private async postTrail(text: string): Promise<void> {
    if (this.stopped || !this.meeting) return;
    this.selfSaving = true;

    try {
      await createDemoMessage(this.store, {
        parent: this.meeting,
        author: this.manifest.personas.mara,
        text,
        extraClasses: [dataBrowser.classes.followEvent],
      });
    } catch (e) {
      console.warn('[Demo] could not post meeting trail:', e);
    } finally {
      this.selfSaving = false;
    }
  }

  /** Mara-authored narration in the meeting chat (a regular message,
   *  so it reads as speech, not a system event). Posts after a
   *  length-proportional compose pause — a beat to think, then typing
   *  time — so back-to-back narration paces like a person chatting
   *  instead of a script dumping lines. */
  private async narrate(text: string): Promise<void> {
    if (this.stopped || !this.meeting) return;

    await this.sleep(700 + text.length * 40 + Math.random() * 500);

    if (this.stopped || !this.meeting) return;
    this.selfSaving = true;

    try {
      await createDemoMessage(this.store, {
        parent: this.meeting,
        author: this.manifest.personas.mara,
        text,
      });
    } catch (e) {
      console.warn('[Demo] could not narrate:', e);
    } finally {
      this.selfSaving = false;
    }
  }

  // ─── Meeting ─────────────────────────────────────────────────────

  /** Mara starts the tour Meeting: a ChatRoom+Meeting listed in the
   *  drive's `currentMeetings`, which lights up the Join banner. The
   *  drive/meeting genesis is user-signed (only the user's agent can),
   *  guarded against the reactive triggers. */
  private async startTourMeeting(): Promise<void> {
    if (this.meeting || this.stopped) return;
    this.selfSaving = true;

    try {
      // Same standard location real meetings use: the drive's Meetings
      // folder, found (or created) via its `meetingsFolder` pointer.
      const meetingsFolder = await getOrCreateMeetingsFolder(
        this.store,
        this.manifest.drive,
      );

      const meeting = await this.store.newResource({
        parent: meetingsFolder,
        isA: [dataBrowser.classes.chatroom, dataBrowser.classes.meeting],
        propVals: { [core.properties.name]: 'Onboarding tour' },
      });
      await meeting.save();

      const drive = await this.store.getResource(this.manifest.drive);
      drive.push(
        dataBrowser.properties.currentMeetings,
        [meeting.subject],
        true,
      );
      await drive.save();

      this.meeting = meeting.subject;
    } catch (e) {
      console.warn('[Demo] could not start meeting:', e);
    } finally {
      this.selfSaving = false;
    }

    // Re-announce so Mara's presence session now points at the meeting.
    if (this.personas.mara.entry) {
      this.announceMara(this.personas.mara.entry.resource!);
    }
  }

  /** De-list the tour meeting (the log resource stays). */
  private async endTourMeeting(): Promise<void> {
    const meeting = this.meeting;
    if (!meeting) return;

    // Close the feed with an explicit end marker before de-listing.
    await createDemoMessage(this.store, {
      parent: meeting,
      author: this.manifest.personas.mara,
      text: 'The meeting has ended.',
      extraClasses: [dataBrowser.classes.followEvent],
    }).catch(() => undefined);

    this.meeting = undefined;
    this.selfSaving = true;

    try {
      const drive = await this.store.getResource(this.manifest.drive);
      const current = (drive.get(dataBrowser.properties.currentMeetings) ??
        []) as string[];
      await drive.set(
        dataBrowser.properties.currentMeetings,
        current.filter(subject => subject !== meeting),
      );
      await drive.save();
    } catch (e) {
      console.warn('[Demo] could not end meeting:', e);
    } finally {
      this.selfSaving = false;
    }
  }

  // ─── Timing ──────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        // Pause while the tab is hidden: resume (and only then resolve)
        // once the user is back, so they don't miss the show.
        if (document.hidden && !this.stopped) {
          const onVisible = () => {
            document.removeEventListener('visibilitychange', onVisible);
            resolve();
          };

          document.addEventListener('visibilitychange', onVisible);
        } else {
          resolve();
        }
      };

      setTimeout(finish, ms);
    });
  }

  /** Resolves `true` once the user's presence entry starts following
   *  Mara (i.e. they clicked Join), `false` after the timeout. */
  private waitForJoin(timeoutMs: number): Promise<boolean> {
    if (this.maraFollowed) return Promise.resolve(true);

    return new Promise<boolean>(resolve => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (this.stopped || this.maraFollowed) {
          clearInterval(timer);
          resolve(this.maraFollowed);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 400);
    });
  }

  /** Resolves `true` once the user posts a message in the meeting chat,
   *  `false` after the timeout. */
  private waitForUserChat(timeoutMs: number): Promise<boolean> {
    if (this.userChatted) return Promise.resolve(true);

    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.userChatWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/** Follow-trail entry matching FollowContext's format: a markdown link
 *  to what the followed agent is looking at. */
function viewingMessage(store: Store, subject: string): string {
  const title =
    (store.resources.get(subject)?.get(core.properties.name) as
      | string
      | undefined) ?? 'a resource';

  return `Viewing [${title}](${subject})`;
}
