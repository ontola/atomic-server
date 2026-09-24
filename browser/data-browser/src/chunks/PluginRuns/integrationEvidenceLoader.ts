// @wc-ignore-file
import report from '../../../../../integrations/evidence.json';
import { assessEvidence } from '../../../../../integrations/tooling/evidence.mjs';
import { fetchIntegrationSource } from '@helpers/integrationSource';

export type BundledEvidenceId =
  | 'github-issues'
  | 'notion'
  | 'clockify'
  | 'mt940'
  | 'pets';

export async function loadEvidence(id: BundledEvidenceId, server: string) {
  const source = await fetchIntegrationSource(id, server);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  );
  const hash = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

  return assessEvidence(report, id, hash);
}
