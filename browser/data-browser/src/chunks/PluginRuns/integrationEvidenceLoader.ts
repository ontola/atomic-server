// @wc-ignore-file
import report from '../../../../../integrations/evidence.json';
import { assessEvidence } from '../../../../../integrations/tooling/evidence.mjs';
import { fetchIntegrationSource } from '@helpers/integrationSource';

export type BundledEvidenceId = 'github-issues' | 'notion' | 'mt940' | 'pets';

export async function loadEvidence(server: string, id: BundledEvidenceId) {
  const source = await fetchIntegrationSource(server, id);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  );
  const hash = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

  return assessEvidence(report, id, hash);
}
