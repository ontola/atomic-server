import { StoreEvents } from '@tomic/lib';
import { UndoManager, type LoroDoc } from 'loro-crdt';

type UndoCallbacks = {
  push?: Parameters<UndoManager['setOnPush']>[0];
  pop?: Parameters<UndoManager['setOnPop']>[0];
};
type Binding = UndoCallbacks & { active: () => boolean };
type CallbackOwner = { current?: Binding; raw: UndoManager };
type Session = {
  agentSubject: string | undefined;
  generation: number;
  documents: WeakMap<LoroDoc, UndoManager>;
  managers: Set<WeakRef<UndoManager>>;
  listeners: Set<() => void>;
};
type StoreWithAgentEvents = {
  getAgent?: () => { subject?: string } | undefined;
  on: (event: StoreEvents, listener: (agent: unknown) => void) => () => void;
};

const sessions = new WeakMap<StoreWithAgentEvents, Session>();
const callbackOwners = new WeakMap<UndoManager, CallbackOwner>();

function install(owner: CallbackOwner, binding: Binding | undefined): void {
  owner.current = binding;
  owner.raw.setOnPush(binding?.push);
  owner.raw.setOnPop(binding?.pop);
}

function ownerFor(raw: UndoManager): CallbackOwner {
  let owner = callbackOwners.get(raw);

  if (!owner) {
    owner = { raw };
    callbackOwners.set(raw, owner);
  }

  return owner;
}

function sessionFor(store: StoreWithAgentEvents): Session {
  let session = sessions.get(store);
  if (session) return session;
  session = {
    agentSubject: store.getAgent?.()?.subject,
    generation: 0,
    documents: new WeakMap(),
    managers: new Set(),
    listeners: new Set(),
  };
  sessions.set(store, session);
  store.on(StoreEvents.AgentChanged, agent => {
    const next = agent as { subject?: string } | undefined;
    const nextSubject = next?.subject;
    if (session!.agentSubject === nextSubject) return;
    // Resources can retain their LoroDoc across authentication changes. An
    // UndoManager binds a peer identity, so replace the map at this boundary.
    session!.agentSubject = nextSubject;
    session!.generation += 1;

    for (const managerRef of session!.managers) {
      const manager = managerRef.deref();
      if (!manager) continue;
      install(ownerFor(manager), undefined);
      manager.free();
      callbackOwners.delete(manager);
    }

    session!.documents = new WeakMap();
    session!.managers.clear();
    session!.listeners.forEach(listener => listener());
  });

  return session;
}

/** Gets RTE-local history for a document in the current Store auth session. */
export function getDocumentUndoManager(
  store: StoreWithAgentEvents,
  doc: LoroDoc,
): UndoManager {
  const session = sessionFor(store);
  const existing = session.documents.get(doc);
  if (existing) return existing;
  const manager = new UndoManager(doc, {
    maxUndoSteps: 100,
    mergeInterval: 1000,
    excludeOriginPrefixes: ['origin:system', 'atomic:system', 'sys:init'],
  });
  session.documents.set(doc, manager);
  session.managers.add(new WeakRef(manager));

  return manager;
}

export function subscribeDocumentUndoSession(
  store: StoreWithAgentEvents,
  listener: () => void,
): () => void {
  const session = sessionFor(store);
  session.listeners.add(listener);

  return () => session.listeners.delete(listener);
}

export function getDocumentUndoSessionGeneration(
  store: StoreWithAgentEvents,
): number {
  return sessionFor(store).generation;
}

/** LoroUndoPlugin has singleton callbacks, so only the owning view may clear them. */
export function createDocumentUndoViewManager(
  raw: UndoManager,
  active: () => boolean,
): UndoManager {
  const owner = ownerFor(raw);
  const binding: Binding = { active };

  const setCallback = <K extends keyof UndoCallbacks>(
    key: K,
    listener: UndoCallbacks[K],
  ) => {
    (binding as UndoCallbacks)[key] = listener;
    if (!active()) return;

    if (listener) {
      owner.current = binding;
      owner.raw[key === 'push' ? 'setOnPush' : 'setOnPop'](listener as never);

      return;
    }

    if (owner.current === binding) install(owner, undefined);
  };

  return new Proxy(raw, {
    get(target, key) {
      if (key === 'setOnPush')
        return (listener?: UndoCallbacks['push']) =>
          setCallback('push', listener);
      if (key === 'setOnPop')
        return (listener?: UndoCallbacks['pop']) =>
          setCallback('pop', listener);
      if (!active()) return () => false;
      if (key === 'canUndo' || key === 'canRedo')
        return () => active() && target[key]();
      if (key === 'undo' || key === 'redo')
        return () => (active() ? target[key]() : false);
      const value = Reflect.get(target, key, target);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function getDocumentUndoViewManager(
  store: StoreWithAgentEvents,
  doc: LoroDoc,
): UndoManager {
  const session = sessionFor(store);
  const generation = session.generation;

  return createDocumentUndoViewManager(
    getDocumentUndoManager(store, doc),
    () => session.generation === generation,
  );
}
