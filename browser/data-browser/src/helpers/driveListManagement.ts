import { canonicalizeScheme, server, type Resource } from '@tomic/lib';

const pending = new WeakMap<Resource, Promise<void>>();

/** Only edits the owner's index. Never fetches or deletes a target drive. */
export function setDriveListVisibility(
  home: Resource,
  subjects: string[],
  visible: boolean,
): Promise<void> {
  // Two rapid clicks must read the index after the preceding edit has saved.
  const next = (pending.get(home) ?? Promise.resolve())
    .catch(() => {})
    .then(() => update(home, subjects, visible));
  pending.set(home, next);

  return next;
}

async function update(home: Resource, subjects: string[], visible: boolean) {
  if (!home.isReady() || home.error) {
    throw new Error(
      'Your private drive must finish loading before changing your drive list.',
    );
  }

  const own = canonicalizeScheme(home.subject);
  const targets = new Set(
    subjects.map(canonicalizeScheme).filter(s => s !== own),
  );
  if (!targets.size) return;
  const saved = home.getSubjects(server.properties.drives);
  const hidden = home.getSubjects(server.properties.hiddenDrives);
  const withoutTargets = (list: string[]) =>
    list.filter(s => !targets.has(canonicalizeScheme(s)));
  const nextSaved = visible
    ? [...withoutTargets(saved), ...targets]
    : withoutTargets(saved);
  const nextHidden = visible
    ? withoutTargets(hidden)
    : [...withoutTargets(hidden), ...targets];

  await home.set(server.properties.drives, nextSaved);
  await home.set(server.properties.hiddenDrives, nextHidden);
  await home.save();
}

export function visibleDrives(subjects: string[], hidden: string[]): string[] {
  const excluded = new Set(hidden.map(canonicalizeScheme));

  return subjects.filter(s => !excluded.has(canonicalizeScheme(s)));
}
