import { notifications } from './ontologies/notifications.js';
import { properties } from './urls.js';
import type { Resource } from './resource.js';

/** Agent DIDs look like `did:ad:agent:{publicKey}`. */
export function isAgentSubject(subject: string): boolean {
  return subject.startsWith('did:ad:agent:');
}

/**
 * TipTap / ProseMirror JSON node shapes we care about for mention extraction.
 * Document `@` embeds use `atomic-data-resource` / `atomic-data-resource-inline`
 * with a `subject` attr. AI chat uses `mention` (out of scope for notifications).
 */
export type MentionScanNode = {
  type?: string;
  attrs?: { subject?: string; id?: string };
  content?: MentionScanNode[];
};

/** Collect unique agent subjects from TipTap document JSON. */
export function extractAgentMentionsFromTipTap(
  doc: MentionScanNode | null | undefined,
): string[] {
  if (!doc) {
    return [];
  }

  const found = new Set<string>();

  const walk = (node: MentionScanNode) => {
    const type = node.type;

    if (
      type === 'atomic-data-resource' ||
      type === 'atomic-data-resource-inline'
    ) {
      const subject = node.attrs?.subject;

      if (typeof subject === 'string' && isAgentSubject(subject)) {
        found.add(subject);
      }
    }

    // Agent subjects embedded as AI-style mention attrs (id) — only if they are
    // agent DIDs; AI context mentions of arbitrary resources stay out.
    if (type === 'mention') {
      const id = node.attrs?.id;

      if (typeof id === 'string' && isAgentSubject(id)) {
        found.add(id);
      }
    }

    for (const child of node.content ?? []) {
      walk(child);
    }
  };

  walk(doc);

  return [...found];
}

/**
 * Collect unique agent subjects from free text / markdown (chat messages).
 * Matches bare `did:ad:agent:…` tokens.
 */
export function extractAgentMentionsFromText(text: string): string[] {
  if (!text) {
    return [];
  }

  const found = new Set<string>();
  // Public keys are URL-safe base64-ish; keep the match bounded.
  const re = /did:ad:agent:[A-Za-z0-9_-]+/g;

  for (const match of text.matchAll(re)) {
    found.add(match[0]);
  }

  return [...found];
}

/**
 * Write (or clear) the `mentions` property on a resource from a list of agent
 * subjects. No-op when the set is unchanged. Does not save — caller saves.
 */
export async function applyMentionsProperty(
  resource: Resource,
  agentSubjects: string[],
): Promise<boolean> {
  const unique = [...new Set(agentSubjects.filter(isAgentSubject))].sort();
  const existing = (resource.get(notifications.properties.mentions) as
    | string[]
    | undefined) ?? [];
  const existingSorted = [...existing].sort();

  if (
    unique.length === existingSorted.length &&
    unique.every((s, i) => s === existingSorted[i])
  ) {
    return false;
  }

  if (unique.length === 0) {
    if (existing.length === 0) {
      return false;
    }

    // Clear the property when no agents remain.
    resource.remove(notifications.properties.mentions);

    return true;
  }

  await resource.set(notifications.properties.mentions, unique);

  return true;
}

/** Stable dedupe key for a mention NotificationItem. */
export function mentionDedupeKey(
  about: string,
  actor: string,
  mentionedAgent: string,
): string {
  return `mention|${about}|${actor}|${mentionedAgent}`;
}

/** Stable dedupe key for a watch NotificationItem. */
export function watchDedupeKey(
  type: 'watch-membership' | 'watch-content',
  about: string,
  watchTarget: string,
  actor: string,
): string {
  return `${type}|${about}|${watchTarget}|${actor}`;
}

/** Read `createdBy` from a resource, falling back to undefined. */
export function resourceActor(resource: Resource): string | undefined {
  const createdBy = resource.get(properties.createdBy);

  return typeof createdBy === 'string' ? createdBy : undefined;
}
