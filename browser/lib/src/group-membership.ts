import { classes } from './urls.js';

/** Upper bound on the groups visited resolving one membership. Fails closed. */
export const MAX_GROUPS_VISITED = 256;

const GROUP_MEMBERS = 'https://atomicdata.dev/properties/group/members';
const AGENT_PREFIX = 'did:ad:agent:';

interface GroupLike {
  hasClasses(...classes: string[]): boolean;
  get(property: string): unknown;
}

interface GroupStoreLike {
  getResource(subject: string): Promise<GroupLike>;
}

/** Whether a rights-list entry names something that may be a Group. */
export function isGroupCandidate(entry: string): boolean {
  return !entry.startsWith(AGENT_PREFIX);
}

/**
 * Whether `agent` is a member of `group`, directly or through nested groups.
 * Mirrors `is_group_member` in `lib/src/hierarchy.rs`: breadth-first with a
 * visited set (cycles terminate and grant nothing), capped at
 * {@link MAX_GROUPS_VISITED} groups, and nothing is cached across calls so a
 * membership change applies on the next check. Only existing resources of
 * class Group count; anything unfetchable has no members (fails closed).
 */
export async function isGroupMember(
  store: GroupStoreLike,
  group: string,
  agent: string,
): Promise<boolean> {
  const visited = new Set<string>([group]);
  const queue = [group];
  let explored = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (explored >= MAX_GROUPS_VISITED) return false;

    explored++;

    let resource: GroupLike;

    try {
      resource = await store.getResource(current);
    } catch {
      continue;
    }

    if (!resource.hasClasses(classes.group)) continue;

    const members = resource.get(GROUP_MEMBERS);

    if (!Array.isArray(members)) continue;

    for (const member of members as string[]) {
      if (member === agent) return true;

      if (isGroupCandidate(member) && !visited.has(member)) {
        visited.add(member);
        queue.push(member);
      }
    }
  }

  return false;
}
