import { joinCall } from './hostActions';

/**
 * Pressing the call button in the embed: the app starts the call, and joining
 * it also joins the meeting the way the web's Join does (follow its leader)
 * when this session is neither leading nor already following. Resolves false
 * when the app cannot place the call.
 */
export async function startHostCall({
  meeting,
  leader,
  leading,
  followed,
  follow,
}: {
  meeting: string;
  /** The agent that leads the meeting, when known. */
  leader: string | undefined;
  /** This session leads the meeting. */
  leading: boolean;
  /** The agent followed now. */
  followed: string | undefined;
  follow: (agent: string) => void;
}): Promise<boolean> {
  const started = await joinCall(meeting);

  if (started && !leading && leader && followed !== leader) {
    follow(leader);
  }

  return started;
}
