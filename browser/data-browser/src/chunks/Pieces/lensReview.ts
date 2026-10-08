// @wc-ignore-file
import { ensureSchema, type Store } from '@tomic/lib';
import { parseMapping, storedMapping } from './lens';
import { piecesSchema } from './piecesSchema';

/**
 * Approvals bound to a mapping digest (atomic-plugins `ontology-kit/LENSES.md`,
 * "Approvals bound to a mapping digest"; pieces.md L3/O3).
 *
 * Approving a drive-local lens records the digest of what was reviewed: its
 * source, its target and its mapping. The lens is trusted only while that
 * digest matches its current content, so any later edit makes it unreviewed
 * again without anyone resetting a flag. A lens approved before this existed
 * has no digest and needs one more approval. Catalog lenses need none: a
 * published lens file never changes.
 */

/**
 * JSON text with object keys sorted at every level and no whitespace. Array
 * order is kept: it is meaningful in a mapping.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;

    return `{${Object.keys(object)
      .filter(key => object[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

export interface ReviewedContent {
  source: string;
  target: string;
  /** The mapping as stored on the lens; throws if it does not parse. */
  mapping: unknown;
}

/** `sha256:` and the lowercase hex SHA-256 of the canonical content. */
export async function lensReviewDigest({
  source,
  target,
  mapping,
}: ReviewedContent): Promise<string> {
  const text = canonicalJson({
    mapping: storedMapping(parseMapping(mapping)),
    source,
    target,
  });
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );

  return `sha256:${Array.from(new Uint8Array(hash), b =>
    b.toString(16).padStart(2, '0'),
  ).join('')}`;
}

/** Whether a stored review approves exactly this content. */
export async function reviewApproves(
  review: unknown,
  digest: unknown,
  content: ReviewedContent,
): Promise<boolean> {
  if (review !== 'approved' || typeof digest !== 'string') return false;

  return digest === (await lensReviewDigest(content));
}

/**
 * Approves a drive-local lens as it is now: `lens-review` and
 * `lens-review-digest` in one commit. In a real flow this sits on the lens's
 * own page, next to the mapping it digests.
 */
export async function approveLens(
  store: Store,
  drive: string,
  subject: string,
): Promise<void> {
  // Ensured, not found: a drive seeded before approvals carried a digest
  // gets the `lens-review-digest` property on its first approval.
  const { properties: props } = await ensureSchema(
    store,
    drive,
    piecesSchema(),
  );
  const review = props['lens-review'];
  const digestProp = props['lens-review-digest'];

  const lens = await store.getResource(subject);
  const digest = await lensReviewDigest({
    source: lens.get(props['lens-source']) as string,
    target: lens.get(props['lens-target']) as string,
    mapping: lens.get(props['lens-mapping']),
  });
  await lens.set(review, 'approved');
  await lens.set(digestProp, digest);
  await lens.save();
}
