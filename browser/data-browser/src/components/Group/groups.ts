import { urls, type Resource } from '@tomic/react';

/** The `members` property of a Group: a resourceArray of Agents and Groups. */
export const GROUP_MEMBERS = 'https://atomicdata.dev/properties/group/members';

export function isGroup(resource: Resource): boolean {
  return resource.hasClasses(urls.classes.group);
}
