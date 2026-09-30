// @wc-ignore-file
import { type Resource, useCreatedBy, useStore, useString } from '@tomic/react';

export const DEMO_SPEAKER = 'https://atomicdata.dev/properties/demo/speaker';
const DRIVE = 'https://atomicdata.dev/properties/drive';

/**
 * Scripted speech is presentation, never a replacement for signed authorship.
 *
 * A persona's line is signed by the visitor's own guest identity, since this
 * browser writes it. It is shown as the persona when it matches the demo in
 * the stored manifest, or when this browser's own identity signed it: nobody
 * else can have put a speaker on a local-only message signed by us. The
 * second case covers a manifest that names another demo run (a second tab,
 * or a reload that started a new run), which showed Mara's lines as "Demo
 * User".
 */
export function resolveDemoSpeaker(
  creator: string | undefined,
  speaker: string | undefined,
  drive: string | undefined,
  localOnly: boolean,
  manifest: { drive: string; personas: Record<string, string> } | undefined,
  currentAgent?: string,
): string | undefined {
  if (!localOnly || !speaker) return creator;

  const inManifest =
    !!manifest &&
    drive === manifest.drive &&
    Object.values(manifest.personas).includes(speaker);
  const signedHere = !!creator && creator === currentAgent;

  return inManifest || signedHere ? speaker : creator;
}

export function useMessageSpeaker(resource: Resource): string | undefined {
  const creator = useCreatedBy(resource);
  const [speaker] = useString(resource, DEMO_SPEAKER);
  const store = useStore();
  let manifest;

  try {
    const value = JSON.parse(
      localStorage.getItem('atomic.demoWorkspace') ?? 'null',
    );
    if (
      typeof value?.drive === 'string' &&
      value?.personas &&
      typeof value.personas === 'object'
    )
      manifest = value;
  } catch {
    /* No valid demo session. */
  }

  return resolveDemoSpeaker(
    creator,
    speaker,
    resource.get(DRIVE) as string | undefined,
    store.isLocalOnlySubject(resource.subject),
    manifest,
    store.getAgent()?.subject,
  );
}
