// @wc-ignore-file
import { managedFetch } from '../../helpers/managed/api';
import { roomId } from './callTransport';

/** One recording of a Meeting's call, as kept in `meetingRecordings`. */
export type MeetingRecording = {
  /** The MP4, complete a few seconds after the recording stops. */
  mediaUrl: string;
  /** WebVTT subtitles, written on the server some time after it stops. */
  transcriptUrl?: string;
  /** Unix milliseconds. */
  startedAt: number;
  endedAt?: number;
};

export interface RunningRecording {
  egressId: string;
  recording: MeetingRecording;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await managedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status}`);
  }

  return res.json();
}

/** Starts recording the LiveKit room of the Meeting [subject]. */
export async function startRecording(
  subject: string,
  now = Date.now(),
): Promise<RunningRecording> {
  const json = (await post('/meetings/recording/start', {
    room: roomId(subject),
  })) as { egressId: string; mediaUrl: string; transcriptUrl?: string };

  return {
    egressId: json.egressId,
    recording: {
      mediaUrl: json.mediaUrl,
      ...(json.transcriptUrl ? { transcriptUrl: json.transcriptUrl } : {}),
      startedAt: now,
    },
  };
}

/** Stops a recording this account started. */
export async function stopRecording(egressId: string): Promise<void> {
  await post('/meetings/recording/stop', { egressId });
}

/** The Meeting's recordings with [recording] added (or replaced, by URL). */
export function withRecording(
  existing: unknown,
  recording: MeetingRecording,
): MeetingRecording[] {
  const list = Array.isArray(existing)
    ? (existing as MeetingRecording[]).filter(
        r => r && typeof r.mediaUrl === 'string',
      )
    : [];

  return [
    ...list.filter(r => r.mediaUrl !== recording.mediaUrl),
    recording,
  ].sort((a, b) => a.startedAt - b.startedAt);
}
