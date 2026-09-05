import {
  attributionForVersion,
  type HistoryAttribution,
  type Version,
} from '@tomic/react';
import { styled } from 'styled-components';

import type { JSX } from 'react';
import { ResourceInline } from '../../views/ResourceInline/ResourceInline';

const formatter = new Intl.DateTimeFormat('default', {
  month: 'long',
  year: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

export interface VersionTitleProps {
  version: Version;
  /** Signed-envelope attribution for the resource, when any is retained. */
  attribution?: HistoryAttribution | null;
}

/**
 * "Edited <when> by <whom>". The signer comes from a signed envelope whose
 * Loro change token matches this version, and is labelled Verified when the
 * answering node checked the signature. A version no envelope claims falls
 * back to the Loro peer id: that is who typed, not a proof of who signed.
 */
export function VersionTitle({
  version,
  attribution,
}: VersionTitleProps): JSX.Element {
  const date = new Date(version.timestamp);
  const formattedDate = formatter.format(date);
  const signed = attributionForVersion(version, attribution);

  return (
    <span>
      Edited <time dateTime={date.toISOString()}>{formattedDate}</time>
      {signed ? (
        <>
          {' by '}
          <ResourceInline subject={signed.signer} />{' '}
          <Badge
            $verified={signed.verified}
            title={
              signed.verified
                ? "Signature checked against the signer's key"
                : 'Envelope present, but its signature did not verify'
            }
            data-testid='version-attribution'
          >
            {signed.verified ? 'Verified' : 'Unverified'}
          </Badge>
        </>
      ) : (
        version.peer && (
          <>
            {' by peer '}
            {version.peer.slice(0, 8)}...{' '}
            <Badge
              $verified={false}
              title='No signed envelope covers this change on this node'
              data-testid='version-attribution'
            >
              Unattributed
            </Badge>
          </>
        )
      )}
      {version.message && !signed && <> — {version.message}</>}
    </span>
  );
}

const Badge = styled.span<{ $verified: boolean }>`
  display: inline-block;
  padding: 0 0.4em;
  border-radius: ${p => p.theme.radius};
  font-size: 0.8em;
  line-height: 1.6;
  color: ${p => (p.$verified ? 'white' : p.theme.colors.textLight)};
  background-color: ${p =>
    p.$verified ? p.theme.colors.main : p.theme.colors.bg1};
`;
