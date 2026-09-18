import { core } from './ontologies/core.js';
import { dataBrowser } from './ontologies/dataBrowser.js';
import { notifications } from './ontologies/notifications.js';
import type { Resource } from './resource.js';
import { RightType, type Right } from './resource.js';
import type { Store } from './store.js';
import { instances } from './urls.js';

export type RequestedRight = 'read' | 'write';
export type AccessRequestStatus = 'pending' | 'granted' | 'denied';

const PUBLIC_AGENT = instances.publicAgent;

/** True when this subject can be a collaborator (not the public agent). */
export function isCollaboratorSubject(subject: string): boolean {
  return subject.length > 0 && subject !== PUBLIC_AGENT;
}

/**
 * Unique collaborator subjects from a `getRights()` result.
 * Defaults to anyone with read or write. Pass `writersOnly` for grant targets.
 */
export function agentSubjectsFromRights(
  rights: Right[],
  opts: { exclude?: string; writersOnly?: boolean } = {},
): string[] {
  const found = new Set<string>();

  for (const right of rights) {
    if (opts.writersOnly && right.type !== RightType.WRITE) {
      continue;
    }

    if (!isCollaboratorSubject(right.for)) {
      continue;
    }

    if (opts.exclude && right.for === opts.exclude) {
      continue;
    }

    found.add(right.for);
  }

  return [...found];
}

/** Append `agent` to a rights array without duplicates. */
export function mergeAgentIntoRights(
  existing: string[] | undefined,
  agent: string,
): string[] {
  return [...new Set([...(existing ?? []), agent])];
}

export function previewMessageBody(body: string, max = 80): string {
  const trimmed = body.trim().replace(/\s+/g, ' ');

  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, max - 1)}…`;
}

export function messageNotificationSummary(body: string): string {
  const preview = previewMessageBody(body);

  return preview.length > 0
    ? `Sent you a message: ${preview}`
    : 'Sent you a message';
}

export function accessRequestNotificationSummary(
  right: string,
  targetTitle: string,
): string {
  return `Requested ${right} access to ${targetTitle}`;
}

async function parentIfWritable(
  store: Store,
  parent: string | undefined,
  agent: string | undefined,
): Promise<string | undefined> {
  if (!parent || !agent) {
    return undefined;
  }

  try {
    const res = await store.getResource(parent);
    const [ok] = await res.canWrite(agent);

    if (ok) {
      return parent;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Agents on a drive (or any resource) who share read/write, excluding
 * `exclude` and the public agent. Used to pick a message recipient.
 */
export async function listCollaborators(
  resource: Resource,
  opts: { exclude?: string; writersOnly?: boolean } = {},
): Promise<string[]> {
  const rights = await resource.getRights();

  return agentSubjectsFromRights(rights, opts);
}

/**
 * Who should be notified of an access request: writers of the target
 * (including inherited), falling back to `createdBy`.
 */
export async function listAccessRequestRecipients(
  resource: Resource,
  exclude?: string,
): Promise<string[]> {
  const writers = await listCollaborators(resource, {
    exclude,
    writersOnly: true,
  });

  if (writers.length > 0) {
    return writers;
  }

  const actor = resource.getCreatedBy();

  if (
    typeof actor === 'string' &&
    actor !== exclude &&
    isCollaboratorSubject(actor)
  ) {
    return [actor];
  }

  return [];
}

export interface CreateDirectMessageOpts {
  store: Store;
  /** Preferred parent (usually the current drive). Falls back to `fallbackParent`. */
  preferredParent?: string;
  fallbackParent: string;
  recipient: string;
  body: string;
  sender: string;
}

/** Create a DirectMessage with `mentions` = recipient. Does save. */
export async function createDirectMessage(
  opts: CreateDirectMessageOpts,
): Promise<Resource> {
  const parent =
    (await parentIfWritable(opts.store, opts.preferredParent, opts.sender)) ??
    opts.fallbackParent;

  const preview = previewMessageBody(opts.body, 60);
  const extraRead =
    parent === opts.fallbackParent
      ? mergeAgentIntoRights([opts.sender], opts.recipient)
      : undefined;

  const resource = await opts.store.newResource({
    parent,
    isA: [notifications.classes.directMessage],
    propVals: {
      [core.properties.name]: preview || 'Message',
      [core.properties.description]: opts.body,
      [notifications.properties.mentions]: [opts.recipient],
      ...(extraRead && { [core.properties.read]: extraRead }),
    },
  });

  await resource.save();

  return resource;
}

export interface CreateAccessRequestOpts {
  store: Store;
  target: Resource;
  recipients: string[];
  requestedRight: RequestedRight;
  message?: string;
  requester: string;
  fallbackParent: string;
}

/** Create an AccessRequest mentioning grant-capable agents. Does save. */
export async function createAccessRequest(
  opts: CreateAccessRequestOpts,
): Promise<Resource> {
  const targetParent = opts.target.get(core.properties.parent) as
    | string
    | undefined;
  const parent =
    (await parentIfWritable(opts.store, targetParent, opts.requester)) ??
    (await parentIfWritable(opts.store, opts.target.subject, opts.requester)) ??
    opts.fallbackParent;

  const extraRead =
    parent === opts.fallbackParent
      ? mergeAgentIntoRights(
          [opts.requester, ...opts.recipients],
          opts.requester,
        )
      : undefined;

  const title =
    (opts.target.get(core.properties.name) as string | undefined) ?? 'resource';

  const resource = await opts.store.newResource({
    parent,
    isA: [notifications.classes.accessRequest],
    propVals: {
      [core.properties.name]: `Access request: ${title}`,
      [dataBrowser.properties.about]: opts.target.subject,
      [notifications.properties.mentions]: opts.recipients,
      [notifications.properties.requestedRight]: opts.requestedRight,
      [notifications.properties.accessRequestStatus]: 'pending',
      ...(opts.message && {
        [core.properties.description]: opts.message,
      }),
      ...(extraRead && { [core.properties.read]: extraRead }),
    },
  });

  await resource.save();

  return resource;
}

/**
 * Add `requester` to the target's read (and write, when requested) arrays
 * and mark the AccessRequest granted. Does save both.
 */
export async function grantAccessRequest(
  store: Store,
  accessRequest: Resource,
): Promise<void> {
  const targetSubject = accessRequest.get(dataBrowser.properties.about) as
    | string
    | undefined;

  if (!targetSubject) {
    throw new Error('Access request has no target');
  }

  const requester = accessRequest.getCreatedBy();

  if (!requester) {
    throw new Error('Access request has no requester');
  }

  const right =
    (accessRequest.get(notifications.properties.requestedRight) as
      | RequestedRight
      | undefined) ?? 'read';

  const target = await store.getResource(targetSubject);
  const readers = mergeAgentIntoRights(
    target.get(core.properties.read) as string[] | undefined,
    requester,
  );
  await target.set(core.properties.read, readers);

  if (right === 'write') {
    const writers = mergeAgentIntoRights(
      target.get(core.properties.write) as string[] | undefined,
      requester,
    );
    await target.set(core.properties.write, writers);
  }

  await target.save();
  await accessRequest.set(
    notifications.properties.accessRequestStatus,
    'granted',
  );
  await accessRequest.save();
  store.notifyResourceUpdated(accessRequest);
  store.notifyResourceUpdated(target);
}
