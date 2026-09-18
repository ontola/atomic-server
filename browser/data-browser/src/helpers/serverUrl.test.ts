import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  isLocalAddress,
  normalizeServerUrl,
  sameOrigin,
  serverLabel,
} from './serverUrl';

/**
 * Shared with `flutter/lib/atomic/server_url.dart`. A rename or scheme
 * default that only updates one suite is how a phone and the browser
 * disagree on the same typed host.
 */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../testdata/server-url.json', import.meta.url),
    ),
    'utf-8',
  ),
) as {
  normalize: { input: string; normalized: string }[];
  isLocal: { authority: string; local: boolean }[];
  sameOrigin: { a: string; b: string | null; same: boolean }[];
  serverLabel: { url: string; label: string }[];
};

describe('serverUrl', () => {
  it('normalizes the shared fixture the same way as Flutter', () => {
    for (const { input, normalized } of fixture.normalize) {
      expect(normalizeServerUrl(input)).toBe(normalized);
    }
  });

  it('classifies local vs public authorities with Flutter', () => {
    for (const { authority, local } of fixture.isLocal) {
      expect(isLocalAddress(authority)).toBe(local);
    }
  });

  it('compares origins with Flutter', () => {
    for (const { a, b, same } of fixture.sameOrigin) {
      expect(sameOrigin(a, b ?? undefined)).toBe(same);
    }
  });

  it('labels servers with Flutter', () => {
    for (const { url, label } of fixture.serverLabel) {
      expect(serverLabel(url)).toBe(label);
    }
  });

  it('empty input currently becomes https:// (Flutter returns empty)', () => {
    // Documented drift — not in the shared fixture. Do not "fix" here.
    expect(normalizeServerUrl('')).toBe('https://');
    expect(normalizeServerUrl('   ')).toBe('https://');
  });
});
