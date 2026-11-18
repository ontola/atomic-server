// @wc-ignore-file
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, lensReviewDigest, reviewApproves } from './lensReview';

const SOURCE = 'https://drive.example/classes/time-entry';
const TARGET = 'https://drive.example/classes/toggl-time-entry';
const mapping = {
  version: 1,
  fields: [
    {
      target: 'https://drive.example/properties/toggl-start',
      source: 'https://drive.example/properties/entry-start',
      convert: 'ms-to-iso',
    },
  ],
};
const content = { source: SOURCE, target: TARGET, mapping };

describe('approvals bound to a mapping digest', () => {
  it('writes canonical JSON: sorted keys, no whitespace, array order kept', () => {
    expect(canonicalJson({ b: [2, 1], a: { d: null, c: 'x' } })).toBe(
      '{"a":{"c":"x","d":null},"b":[2,1]}',
    );
  });

  it('digests source, target and the stored mapping with SHA-256', async () => {
    const text = canonicalJson({
      mapping: {
        version: 1,
        fields: [
          {
            convert: 'ms-to-iso',
            source: 'https://drive.example/properties/entry-start',
            target: 'https://drive.example/properties/toggl-start',
          },
        ],
      },
      source: SOURCE,
      target: TARGET,
    });

    expect(await lensReviewDigest(content)).toBe(
      `sha256:${createHash('sha256').update(text).digest('hex')}`,
    );
    // The mapping's JSON text or its key order does not matter.
    expect(
      await lensReviewDigest({ ...content, mapping: JSON.stringify(mapping) }),
    ).toBe(await lensReviewDigest(content));
  });

  it('trusts an approval only while the content is what was approved', async () => {
    const digest = await lensReviewDigest(content);

    expect(await reviewApproves('approved', digest, content)).toBe(true);
    expect(
      await reviewApproves('approved', digest, {
        ...content,
        mapping: {
          version: 1,
          fields: [{ ...mapping.fields[0], convert: 'identity' }],
        },
      }),
    ).toBe(false);
    expect(
      await reviewApproves('approved', digest, { ...content, target: SOURCE }),
    ).toBe(false);
    expect(await reviewApproves('pending', digest, content)).toBe(false);
  });

  it('needs a new approval for a lens approved without a digest', async () => {
    expect(await reviewApproves('approved', undefined, content)).toBe(false);
  });
});
