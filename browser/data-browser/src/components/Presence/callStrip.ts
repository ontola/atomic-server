import type { PresenceItem } from '@tomic/react';

/**
 * The agents in the video call of `meeting`, from drive presence, and whether
 * the "Video call" strip shows: someone is in it and this session is not.
 * `inCall` is this session's own: the inline call on the web, the app's call
 * in the embed. Presence is not trusted for that, as an embed's list leaves
 * out its own device.
 */
export function callStrip(
  presence: PresenceItem[],
  meeting: string,
  inCall: boolean,
): { agents: string[]; show: boolean } {
  const agents = [
    ...new Set(
      presence.filter(item => item.call === meeting).map(item => item.agent),
    ),
  ];

  return { agents, show: !inCall && agents.length > 0 };
}
