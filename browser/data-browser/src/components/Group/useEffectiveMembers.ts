import { useEffect, useState } from 'react';
import { useArray, useStore, type Resource } from '@tomic/react';
import { GROUP_MEMBERS, isGroup } from './groups';

/**
 * Everyone who ends up covered when `group` is named in a rights list: the
 * agents in it and, through nested groups, in the groups below it. Mirrors the
 * server, where a cycle grants nothing extra and a member that is neither an
 * Agent nor a loadable Group is skipped.
 */
export function useEffectiveMembers(group: Resource): {
  agents: string[];
  loading: boolean;
} {
  const store = useStore();
  const [direct] = useArray(group, GROUP_MEMBERS);
  const key = direct.join(' ');
  const [state, setState] = useState<{ key: string; agents: string[] }>();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const agents = new Set<string>();
      const seen = new Set<string>([group.subject]);
      const queue = key.split(' ').filter(Boolean);

      while (queue.length > 0) {
        const subject = queue.shift()!;

        if (seen.has(subject)) continue;

        seen.add(subject);

        try {
          const member = await store.getResource(subject);

          if (isGroup(member)) {
            queue.push(...((member.get(GROUP_MEMBERS) as string[]) ?? []));
          } else {
            agents.add(subject);
          }
        } catch {
          // A member we cannot read grants nothing we can show.
        }
      }

      if (!cancelled) setState({ key, agents: [...agents] });
    })();

    return () => {
      cancelled = true;
    };
  }, [key, group.subject, store]);

  return {
    agents: state?.key === key ? state.agents : [],
    loading: state?.key !== key,
  };
}
