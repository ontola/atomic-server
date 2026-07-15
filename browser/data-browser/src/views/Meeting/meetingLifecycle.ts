export type MeetingPhase = 'agenda' | 'notes' | 'minutes';

export function getMeetingPhase(
  startedAt: number | undefined,
  endedAt: number | undefined,
): MeetingPhase {
  if (endedAt) return 'minutes';
  if (startedAt) return 'notes';

  return 'agenda';
}
